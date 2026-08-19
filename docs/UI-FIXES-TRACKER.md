# UI Fixes Tracker — Chrome Agent Platform

Discipline: every Paul ask → an entry here → a subagent fixes + VERIFIES in the real extension → checked off. Nothing dropped. Stale/duplicate entries are a defect.

**Reconciled 2026-08-17 against the current code (HEAD 431bf59).** Items below are grouped; each is verified against the committed code, not the worker's claim.

## Open

### WebMCP discovery (Paul 2026-08-18 — "where is the content script?")
- **Paul's exact observable failure:** "Where is the WebMCP content script that looks at the page and determines which functions/tools it can register? It is not visible in Chrome DevTools Sources and there are no logs proving it runs."
- **Round-28 review BLOCK:** the first fix's browser evidence bypassed the implementation (Runtime.evaluate'd source, direct route calls), and the review found a cancellation regression, no post-reload generation sync, an NTP-selecting "Discover this page", blind window.* inference, forgeable status, duplicate listeners on re-enroll, stale tools never removed, and partial injection reported as success. The premature "Done" wording was reverted — this item stayed open.
- **Round-30 correction:** production acceptance now enters extension-only `tools.invoke` and the real `invokeSiteTool`; enrollment binds the picker-approved tab and active `documentId`; SW-issued navigation epochs reject other/stale same-origin documents; immutable cancellation epochs prevent post-resume late results; cross-world transport is MAC/replay-fenced with an out-of-band key; repeated injection is function-scoped so singleton teardown actually runs; and diagnostics redact page exception bodies. MAIN remains page-controlled and is not described as attested.
- **Evidence status:** prior 32/32 artifacts are superseded and do not prove this correction. Generate exact-clean-commit browser evidence outside the source tree with `WEBMCP_ARTIFACT_DIR=… deno run -A scripts/webmcp-acceptance.ts`; independent re-review is still required.
- **Residual (why this is still OPEN):** the OS-level host-permission prompt cannot be automated headless (auto-denied; no display here). Complete the attestation with `deno run -A scripts/webmcp-acceptance.ts --headed` + the two manual Allow clicks — the executable macro in docs/WEBMCP-ACCEPTANCE.md.

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
- **Collapsed-rail geometry (2026-08-18)** — the `new-task`/`create-agent`/Skills/Directory/Settings rail icons now share ONE size + icon convention (inline SVG plus + SVG × delete, 34×34 centred when collapsed — previously `new-task` was 28×28 left-aligned at x=16 while `create-agent` was centred at x=13). The collapse control is now an edge **nub** (rounded tab on the sidebar boundary, 44×44 hit target, chevron flips on collapse, RTL mirror + inner border + reduced-motion handled) instead of the undersized 28×28 chevron. Collapsed state persists via the SW `kv.set`/`kv.get` routes, which now report **durable vs permissionless-session fallback** (backend failure is flagged, not silently claimed) — the durability is exposed as a VISIBLE + accessible hint (`role=status aria-live` session-only/error text) plus `data-durability`, and the write queue is serialized before reload (awaited via the public attribute, no `window.*` oracle). The backend-failure/error path is unit-tested (`kvSet` rejects on a backend write failure); there is NO production fault route or test global — build.mjs asserts `kv.fault`/`__setKvFaultForTest`/`__sidebarPersistence`/`__lastViewTransition`/`window.__*` are absent from every shipped JS + the SW bundle. Verified in the real extension: collapsed rail centre spread ≤2px, exactly five 34×34 actions, nub 44×44 + in-bounds + hit-testable above a REAL production thread (typed into `#task-input` + clicked `#run-task`, demo provider ran), Enter/Space toggle + aria/title track, reload persistence after the write settles, RTL inner-boundary centring + border swap, deterministic rapid-toggle + View Transition `finished` awaited (test-injected patch), narrow/dark/reduced-motion matrix. (branch fix/collapsed-sidebar-nub, scripts/ui-integration.ts 40 checks.)
- The collapsed-rail task X (visible on hover + deletes) + the 24px hit target.
- **Current-main Tasks/Agents sidebar parity (Paul Telegram, 2026-08-18)** — Tasks and Agents now use the same fixed-header/intrinsic-list layout, overflow ownership, stable expanded scrollbar gutters, row formatting, and inline-end + alignment. Collapsed lists stay scrollable without a scrollbar consuming the 60px rail; dots, avatars, and both + actions remain centered. The task X uses a centered 28px token-backed hover/focus control, Site-agent discovery copy is no longer duplicated, and `scripts/sidebar-parity.ts` drives populated expanded/collapsed/RTL/dark plus hover/focus/delete/new-task interactions in the real extension with external screenshots.
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
- **Run-status lifecycle fence (2026-08-19)** — fixed the repeatedly reported thinking/loading lifecycle bug class on current main: immutable run/surface owner tokens fence every run's status/progress/result rendering and every asynchronous title/status DOM commit against surface switches AND same-surface double-sends; a newly opened thread hides the prior banner at ownership hand-off, before its asynchronous read settles; a follow-up in an already-open thread no longer restarts the view transition (the banner flash); a progress-port disconnect settles the banner instead of sticking on Working; an orphaned "running…" is owner-reset when a surface leaves. Switched-away execution and SW journal persistence are deliberately unaffected. Covered by the loaded-MV3 lifecycle evidence plus the non-browser switched-surface owner regression.
- The subtle timestamps (a muted divider at ≥5m gaps / the first message).
- The readable tool-result summaries (not raw JSON).
- **Structured tool-call renderer (2026-08-18)** — fixed the live raw/double-encoded JSON card with the shared `<message-bubble>` renderer and `extension/shared/tool-tree.js`: bounded never-throw parsing/serialization, canonical secret redaction, UTF-8 byte caps, accessible collapsible key/value rows, copy controls, timing, and terminal error/abort states. Immutable per-run call IDs pair persisted calls/results across reload; failed SDK tool results remain errors; typed aborts stay authoritative and prevent partial success journaling. The deterministic demo provider exercises genuine production tool calls in an actually loaded MV3 extension. The targeted contract is 83 checks (36 tool-tree + 20 lifecycle + 8 terminal + 19 abort); full feature history is preserved by the integration merge, while exact integration-commit commands, screenshots, hashes, and clean-tree state are retained externally for review.
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
