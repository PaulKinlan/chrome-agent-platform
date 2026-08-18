# UI Fixes Tracker — Chrome Agent Platform

Discipline: every Paul ask → an entry here → a subagent fixes + VERIFIES in the real extension → checked off. Nothing dropped. Stale/duplicate entries are a defect.

**Reconciled 2026-08-17 against the current code (HEAD 431bf59).** Items below are grouped; each is verified against the committed code, not the worker's claim.

## Done (verified in the committed code)

### Settings
- Duplicate back buttons removed (a single back path).
- The "Multiple agents" + "Browser control" + hooks toggles use the shared `<switch-toggle>` Web Component (the root cause was a hand-rolled `<label class="switch">` colliding with theme.css — fixed).
- The hooks section matches the permissions `.perm-row` grid (no layout shift on deny).
- The sticky sidebar nav + the "Back to hub" (single).
- The per-provider model selector (current model lists per provider + an OpenAI-compatible + a working Custom… text input).
- The "Test connection" button per provider (a real round-trip + the specific error).
- Chaos-style semver (scripts/bump-version.mjs + the post-commit auto-bump).

### Hub / sidebar / task list
- The task sidebar (expand/collapse to an icon rail, tooltips, the + new-task button).
- **Collapsed-rail geometry (2026-08-18)** — the `new-task`/`create-agent`/Skills/Directory/Settings rail icons now share ONE size + icon convention (inline SVG plus + SVG × delete, 34×34 centred when collapsed — previously `new-task` was 28×28 left-aligned at x=16 while `create-agent` was centred at x=13). The collapse control is now an edge **nub** (rounded tab on the sidebar boundary, 44×44 hit target, chevron flips on collapse, RTL mirror + inner border + reduced-motion handled) instead of the undersized 28×28 chevron. Collapsed state persists via the SW `kv.set`/`kv.get` routes, which now report **durable vs permissionless-session fallback** (backend failure is flagged, not silently claimed) — the durability is exposed on the rail as `data-durability` and the write queue is serialized + flushable before reload. The backend-failure/error path is unit-tested (`kvSet` rejects on a backend write failure); there is NO production fault route — build.mjs asserts `kv.fault`/`__setKvFaultForTest` are absent from the shipped bundle. Verified in the real extension: collapsed rail centre spread ≤2px, exactly five 34×34 actions, nub 44×44 + in-bounds + hit-testable above a REAL production thread overlay, Enter/Space toggle + aria/title track, reload persistence after an awaited flush, RTL inner-boundary centring + border swap, deterministic rapid-toggle + View Transition `finished` awaited, narrow/dark/reduced-motion matrix. (branch fix/collapsed-sidebar-nub, scripts/ui-integration.ts 41 checks.)
- The collapsed-rail task X (visible on hover + deletes) + the 24px hit target.
- The task title single-line ellipsis + click-to-rename.
- The unified Agents area (Background + Site groupings; only ACTIVE background agents shown + a Configure link).
- Click a named agent → its view (history + run log) + talk to it.
- The background agents: independent, duplicable + editable (the built-in stays pristine), their own OPFS.
- The Recent activity shows WHICH agent did it.
- The ready indicator removed (cleaner header).

### The + menu (media + browser context)
- The + menu anchors to the + button (in-bounds, flips, no frame scroll).
- Add-tab → a tab picker (pick a tab, attach its contents/URL).
- Grab-screenshot → requests the origin permission then captures (captureVisibleTab).
- Record-audio / Capture-camera → request audioCapture/videoCapture on the gesture then capture.
- Record-screen → getDisplayMedia + a visible "Recording… ▸ Stop" chip.
- Add-window → removed (it just opened a new window).
- The media bytes reach the model (the multimodal image part) + render inline in the thread.

### Conversation / thread
- The unified thread surface (Run task → a full-screen thread; the sidebar persists; the current thread selected).
- A single visible view (the hub hidden + the body scroll frozen when a thread/overlay opens — no background scrollbar).
- The live run-status banner (Working… / Done / Failed + the live tool activity) at the BOTTOM of the thread.
- The subtle timestamps (a muted divider at ≥5m gaps / the first message).
- The readable tool-result summaries (not raw JSON).
- The comprehensive + actionable error reporting (the underlying reason + category + what-to-do).
- The thinking box at the bottom of the chat (the spinner).
- The task error logging (a failed task shows WHY, per-task + centralized).
- The / autocomplete (filters as you type, /skill: lists the skills, /task removed) + the @ autocomplete (named + background + site agents, delineated).
- View Transitions (element-morph, respecting prefers-reduced-motion).

### Artifacts / generative-UI
- HTML output renders in the sandboxed double-iframe (the CSP prepended + the self-navigation blocked).
- Click an artifact → "Open" (the view dialog), not "Run"; the reuse button works (overlay or clipboard fallback).
- The artifact gallery + viewer single header (no double back/h1).

### OPFS / memory
- The Data & memory OPFS explorer — a FILE-SYSTEM tree (Master / Named / Background / Site agents, keys as clickable files).
- The per-agent OPFS sandboxes (named/site/background isolated) + the memory_grep tool.
- The real-browser OPFS verification (npm run test:opfs).

### The + menu / popovers / console
- The error console: the per-line Copy + Copy-all + Clear buttons work (the shadow-root outside-click fix) + the panels close-others + they anchor to the trigger.
- The security shield: the granted permissions are removable.

## Open (genuinely remaining — action these)

1. **Browser-control toggle/grant persistence** — Paul flagged "STILL not working" after the item-51 fix; re-verify the toggle stays ON + the grant persists across a reload in the real extension, and fix the actual cause. (The grant-storage read/write is present; the persistence needs a real-browser proof.)

2. **Remove the Chrome Prompt API (Gemini nano) + Demo (local) from the settings provider picker** — both are for internal/testing use only. The picker filtering is IN FLIGHT (uncommitted); verify it lands + only the real chat providers show.

3. **WebMCP discovery** — the site agents still don't pick up the inferred/known WebMCP tools (Paul: not working). IN FLIGHT (scripts/webmcp-diag.ts); needs the fix + a real-browser integration test (a WebMCP page → the tools discovered), not a mock.

## Evidence
- `npm test` — 298 passed.
- `npm run test:chrome` — 111/120 (9 journeys failing due to the IN-FLIGHT uncommitted work from the running workers; not a committed-state regression — re-check once those workers land).
- `npm run test:components` / `test:security` / `test:opfs` — green in the committed state.

## Notes
- The "Open" list is short (3 items) — the bulk of the backlog is done + verified.
- Items 66/67/68 are carried by workers still running; their edits are uncommitted at reconciliation time.
