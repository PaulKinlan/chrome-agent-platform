# UI Fixes Tracker — Chrome Agent Platform

Discipline: every Paul ask → an entry here → a subagent fixes + VERIFIES in the real extension → checked off. Nothing dropped. Stale/duplicate entries are a defect.

**Reconciled 2026-08-17 against the current code (HEAD 431bf59).** Items below are grouped; each is verified against the committed code, not the worker's claim.

## Open

### WebMCP discovery (Paul 2026-08-18 — "where is the content script?")
- **Paul's exact observable failure:** "Where is the WebMCP content script that looks at the page and determines which functions/tools it can register? It is not visible in Chrome DevTools Sources and there are no logs proving it runs."
- **Round-28 review BLOCK:** the first fix's browser evidence bypassed the implementation (Runtime.evaluate'd source, direct route calls), and the review found a cancellation regression, no post-reload generation sync, an NTP-selecting "Discover this page", blind window.* inference, forgeable status, duplicate listeners on re-enroll, stale tools never removed, and partial injection reported as success. The premature "Done" wording was reverted — this item stayed open.
- **Corrective fix (this round):** gated `[WebMCP:main]` / `[WebMCP:bridge]` / `[WebMCP:sw]` logs behind the Settings → Site agents → Diagnostics toggle; a `webmcp.status` route + Settings/Hub status surface that SEPARATES the SW-attested script lifecycle from page-reported tool data (bounded fields, redacted page errors); bridge startup enrollment sync (`enrollment.status`) so reload/navigation re-authorizes invokes; an explicit tab picker (`agent.discoverable-tabs` + exact `tabId` threading) replacing the active-tab guess; positive opt-in inference (`window.webmcpExpose`) + source-threaded dispatch (declared tools resolve via `document.modelContext`, inferred via the captured exposure registry — never a hijackable `window[name]`); strict schema rejection; in-flight cancellation restored (`inFlight.add` + cancel-all fencing); versioned singleton teardown in both worlds (re-enroll = exactly one listener/side effect); complete ordered replacement snapshots (empty snapshot clears stale tools); per-tab per-role injection readiness (partial surfaced, never counted as success).
- **Proof (real extension, production path):** `scripts/webmcp-acceptance.ts` — 32/32: real UI clicks through the hub picker, the exact picked tab injected, CDP `Debugger.scriptParsed` for both packaged scripts, `[WebMCP]` console lifecycle events, SW→isolated→MAIN invoke with a visible DOM side effect, the declared-vs-global collision assertion, negative rejections, re-enroll singleton, reload + cross-document navigation re-sync; `test-artifacts/webmcp-acceptance-manifest.json` + screenshots.
- **Residual (why this is still OPEN):** the OS-level host-permission prompt gesture cannot be automated headless (auto-denied; no display here). Complete the attestation with `deno run -A scripts/webmcp-acceptance.ts --headed` + the two manual Allow clicks — the executable macro in docs/WEBMCP-ACCEPTANCE.md.

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

## Evidence
- `npm test` — 298 passed.
- `npm run test:chrome` — 111/120 (9 journeys failing due to the IN-FLIGHT uncommitted work from the running workers; not a committed-state regression — re-check once those workers land).
- `npm run test:components` / `test:security` / `test:opfs` — green in the committed state.

## Notes
- The "Open" list is short (3 items) — the bulk of the backlog is done + verified.
- Items 66/67/68 are carried by workers still running; their edits are uncommitted at reconciliation time.
