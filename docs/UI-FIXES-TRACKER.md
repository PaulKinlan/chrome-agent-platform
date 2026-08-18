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
- Settings → Advanced: the layered, versioned system-prompt surface — the read-only built-in viewer (id/version/hash), the per-scope customization editor (append/prepend/replace, save/cancel/reset, dirty + UTF-8 byte-count states, the session-only durability badge), the built-in-updated banner with an old-vs-new diff + keep/reset (acting on the EFFECTIVE override), and the effective composed preview (every layer labelled; the protected runtime policy never editable, always last). The reusable `<system-prompt-editor>` component (single-source components.js + the gallery); full referenced-skill bodies compose before protected-last, every mutation is revision-CAS guarded, and every run records a unique-execution keyed attestation of the exact generate/stream provider-bound message (lib/system-prompts.js — docs/SYSTEM-PROMPTS.md). Verified locally: 50 system-prompt unit tests + 7 Prompt API tests and the 44-check real-extension journey with real pointer/keyboard input + screenshots; exact corrective-HEAD evidence is retained externally for independent review.

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

### Unified agent access
- **CAP-FB-20260818-AGENT-ACCESS-01 — FIXED (2026-08-18, worktree feat/agent-access-picker).** ONE reusable `<agent-picker>` renderer (grouped Named/Background/Site, search, selected/Current, empty/loading/error) consumes the redacted revisioned registry and serves the side panel, every composer's + menu, and strict-position `/agent`; canonical refs route named/background/site runs without collisions. Lifecycle broadcasts, request revision/sequence fences, stale-send rejection, and side-panel history fencing cover mutation races. The side panel includes browse/history/scheduled tasks, removes the iframe/morph stub, and opens real tabs only through the sender-authenticated + current-owner-gesture SW route. Evidence: `scripts/agent-access-journeys.ts` has 88 fixed real-CDP checks and writes nine screenshots plus commit/clean-tree/assertion-set/file-hash metadata outside the repo; general Chrome 119/119, unit 333/333, gallery 35/35, security 7/7, a11y 17/17. Residuals tracked in KNOWN-ISSUES (site-agent delegation is text-only; hub summary rows still use capability-row).

## Open (genuinely remaining — action these)

1. **Browser-control toggle/grant persistence** — Paul flagged "STILL not working" after the item-51 fix; re-verify the toggle stays ON + the grant persists across a reload in the real extension, and fix the actual cause. (The grant-storage read/write is present; the persistence needs a real-browser proof.)

2. **Remove the Chrome Prompt API (Gemini nano) + Demo (local) from the settings provider picker** — both are for internal/testing use only. The picker filtering is IN FLIGHT (uncommitted); verify it lands + only the real chat providers show.

3. **WebMCP discovery** — the site agents still don't pick up the inferred/known WebMCP tools (Paul: not working). IN FLIGHT (scripts/webmcp-diag.ts); needs the fix + a real-browser integration test (a WebMCP page → the tools discovered), not a mock.

## Evidence
- `deno test -A tests/` — 374 passed (incl. 50 system-prompt tests + 7 Prompt API tests: protected-last full-skill composition, exact streaming capture, mandatory CAS/strict quarantine/coordinated lifecycle, FIPS/RFC vectors, malformed-Unicode contracts, versioned key rotation, and run-bound attestation over the real agent core).
- `npm run test:components` — 34/34, the gallery smoke incl. the seeded `<system-prompt-editor>` specimen.
- `deno run -A scripts/system-prompts-integration.ts` — the real-extension Advanced-settings journey, 44/44: REAL pointer/keyboard input (CDP Input.dispatchMouseEvent + Input.insertText), the dirty-scope confirm dialog, mandatory-CAS/key-authority routes, keyed-only preview attestation parity, and a REAL streaming `run-task` whose run-bound attestation matches the previewed composition. Corrective-HEAD logs/screenshots are retained outside the source/docs commit.
- `npm run test:chrome` — 119/119 on the feature head (test-artifacts/chrome-journeys-feature.log).
- `npm run test:ui` — 13/13. The stale recent-activity assertion now waits for `<activity-explorer>`'s async load and inspects its current shadow-DOM row/empty state instead of the removed legacy light-DOM `.rl/.empty` markup.
- `npm run test:security` / `npm run check:gallery` — green.
- The earlier "111/120 Chrome" figure measured a tree with other workers' IN-FLIGHT uncommitted edits; the committed feature head is 119/119.

## Notes
- The "Open" list is short (3 items) — the bulk of the backlog is done + verified.
- Items 66/67/68 are carried by workers still running; their edits are uncommitted at reconciliation time.
