# UI Fixes Tracker — Chrome Agent Platform

Discipline: every Paul ask → an entry here → a subagent fixes + VERIFIES in the real extension → checked off. Nothing dropped. Stale/duplicate entries are a defect.

**Reconciled 2026-08-27 against the current code (`0.2.319` / `origin/main@139b6f92`).**
Items below are grouped; each is verified against the committed code, not the worker's claim.

## Fixed since the 2026-08-21 revision

The 2026-08-26 owner batch (Telegram, 12 items) and its follow-ons all landed. Full
per-item evidence is under `CAP-FB-20260826-OWNER-BATCH-01` in [TASKS.md](../TASKS.md);
one line each here:

- **Back button → blank screen** — fixed at the top frame (`0.2.296`, `0.2.304`).
  Settings/Artifacts/Directory return to the hub in ONE press (the view was called
  "Assets" then and Skills was still a destination; both changed in `0.2.350` —
  `CAP-FB-20260828-NOUN-DISCIPLINE-01`). Settings
  sub-navigation uses `replaceState`, and the Settings brand click goes Home.
- **Permission dead-ends** — approval now surfaces **in the conversation** that needs it
  (`0.2.303`); the orphaned Settings → Approvals section is deleted and revoke confirms
  in-context (`0.2.313`).
- **Usage/token counts always zero** — `0.2.297`. Root cause was a missing
  `stream_options.include_usage`, not the UI.
- **Recent activity search + filters dead** — `0.2.298`. The feed was hanging on profiles
  with many background agents; the controls only looked broken.
- **Run-status cards pushing the page off screen** — `0.2.300`: one subtle line per run,
  plain-English status, capped at the 3 most recent with a quiet "+N earlier runs".
- **Agent list printing the whole role** — `0.2.277`: a two-line preview, full text on hover.
- **Dialog body clipping with many tabs/tools** — `0.2.299`: dialog bodies scroll.
- **Discovered-sites box butting against the container edge** — `0.2.312`.
- **Add-agent empty state / agents-folder "+"** — `0.2.312`.
- **Tool library count disagreeing with the rows** — `0.2.312`: all 130 listed.
- **Background agents separated from the agents list** — `0.2.306`: unified, with a
  runs-in-the-background marker, schedule and toggle; full named-agent delete added.
- **Data & memory Clear looking like it did nothing** — `0.2.265`, `0.2.266`: the clear
  worked, the UI never refreshed; tree expansion is now preserved across the refresh.
- **Surfaces dead-rendering on a suspended worker** — `0.2.302`: honest error + Retry.
- **Artifact viewer as a tiny unclickable box** — `0.2.318`: fills the window, opens in a
  full tab.
- **Theme switcher** — removed (`0.2.301`); it only ever worked on Settings.

## Open

### Scheduled task storage-full flood (2026-08-21 — local successor)
- Retained Durable authority exhausted the owner/model master store's former 500-key ceiling, causing one-shot and recipe alarms to repeat a generic console failure. The fix removes that arbitrary count ceiling, retains byte quotas, isolates each execution's authority, and evicts no data.
- A storage-blocked scheduled row now shows the failed state plus **Storage full — retry or cancel**, exposes a labelled keyboard-focusable Retry action, and retains Delete as owner cancellation. The exact alarm is disarmed after the first transition; a stale already-queued delivery is silent.
- Still open: independent source/a11y review and a short loaded-extension migration → retry → terminal check.

### Task-view View Transition ghost (2026-08-21 — provisional current-main 0.2.118 reconciliation)
- Exact `7d3b3e7e` passed Hub→task and keyboard restore but failed task→Settings and clean-archive changelog shipping. Exact `8b5a6287` fixed those root/build paths, but immutable v2 browser evidence proved the shared old named overlay still faded task controls over Settings: `::view-transition-old(overlay-view)` was visible at opacity `0.197597` at 125 ms while old `root` was correctly hidden.
- Reviewed successor `0d3199a` is reconciled by content onto Directory main `eed40358`. It preserves direction policy and shared `overlay-view` identity. Under the explicit task-boundary class, both old `root` and old `overlay-view` are transparent/non-animated; new `overlay-view` is not targeted and remains named/active. Complete task enter/exit route tests cover Hub, Settings, Directory, Skills, and Artifacts; unrelated full-view routes retain normal named cross-fades. Cleanup/focus/race/reduced-motion and fail-closed changelog shipping remain intact. On same-surface task→named-agent switches, `showThreadView`'s already-open branch synchronously routes explicit focus to the thread composer with a connected guard, preserving no-flash and no-transition invariants. No-argument follow-up/nudge and same-thread-row routes remain focus-neutral, so the default fresh-open title focus cannot steal composer focus. Directory's exact covered `side` + `sideToggle` inert/`aria-hidden` behavior and initiating-trigger focus restoration are retained and composed with post-transition focus.
- Still open: independent current-main source/a11y review and corrected loaded-MV3 midpoint captures for launch, task→Settings, keyboard restore, follow-up focus retention, same-thread row re-click, fresh-open title focus and same-surface agent focus, with zero errors and singular identities/projection. The corrected harness must accept `durable-run-registry` as valid document-level Shadow DOM retargeting and use genuine keyboard/pointer interaction. Reconcile provisional 0.2.118 with concurrent candidates before integration.

### Live durable Tasks sidebar and terminal owner-thread projection (2026-08-21 — accepted for integration)
- Thread-bound durable revisions trigger authoritative `thread.list` replacement while active; terminal/cancelled owner revisions trigger one authoritative `thread.get` replacement. Native click/keyboard behavior, unique rows/results, stale-surface fencing, and prior-row preservation on transient MV3 startup failure remain intact.
- Exact source `dd41258f` / tree `80ca97f0` passed independent source review and exact 7/7 loaded-extension proof. The accepted sequence visibly retains the same native Tasks row, terminal result, registry identity, and logs after hard reload (`07-reload-persistence.png`). This is Durable-lane integration evidence, not whole-product acceptance; independent current-main integration review remains open.

### Permission preflight (Paul 2026-08-19 — presentation-critical)
- Recovery is PARTIAL: unsafe async grant/retry behavior was removed and missing exact provider access now pauses truthfully before execution, but the reusable owner-button preflight and its loaded-MV3/a11y/visual acceptance remain open. Settings is currently the only genuine provider grant surface.

### WebMCP discovery (Paul 2026-08-18 — "where is the content script?")
- **Paul's exact observable failure:** "Where is the WebMCP content script that looks at the page and determines which functions/tools it can register? It is not visible in Chrome DevTools Sources and there are no logs proving it runs."
- **Round-28 review BLOCK:** the first fix's browser evidence bypassed the implementation (Runtime.evaluate'd source, direct route calls), and the review found a cancellation regression, no post-reload generation sync, an NTP-selecting "Discover this page", blind window.* inference, forgeable status, duplicate listeners on re-enroll, stale tools never removed, and partial injection reported as success. The premature "Done" wording was reverted — this item stayed open.
- **Round-30 correction:** production acceptance now enters extension-only `tools.invoke` and the real `invokeSiteTool`; enrollment binds the picker-approved tab and active `documentId`; SW-issued navigation epochs reject other/stale same-origin documents; immutable cancellation epochs prevent post-resume late results; cross-world transport is MAC/replay-fenced with an out-of-band key; repeated injection is function-scoped so singleton teardown actually runs; and diagnostics redact page exception bodies. MAIN remains page-controlled and is not described as attested.
- **Evidence status:** prior 32/32 artifacts are superseded and do not prove this correction. Generate exact-clean-commit browser evidence outside the source tree with `WEBMCP_ARTIFACT_DIR=… deno run -A scripts/webmcp-acceptance.ts`; independent re-review is still required.
- **Residual (why this is still OPEN):** the OS-level host-permission prompt cannot be automated headless (auto-denied; no display here). Complete the attestation with `deno run -A scripts/webmcp-acceptance.ts --headed` + the two manual Allow clicks — the executable macro in docs/WEBMCP-ACCEPTANCE.md.

## Done (verified in the committed code)

### Agent Directory presentation (Paul 2026-08-19)
- The full Directory covered-view state now hides and inerts both the sidebar and its edge nub without changing their thread-view stacking behavior; focus enters the frame only after that reveal, and close removes the inert/AX markers, restores the prior sidebar state, and returns focus only to a still-visible initiating control.
- Each canonical registry function renders through shared `<tool-directory-card>` in semantic name → description/schema metadata → per-function state order. Long registry content wraps inside its own card; source and approval labels carry function-specific accessible names.
- The old-base accepted source `ac72ae19` passed loaded-MV3 acceptance 20/20 (geometry, overflow, hit-testing, restore, exact AX-name, error-free, narrow, RTL, Midnight) with before/after screenshots; the current-main reconciliation of that content (CAP-FB-20260819-AGENT-DIRECTORY-01) carries the same browser evidence requirement — fresh loaded-MV3 runs on the new base remain pending.

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
- **One name per concept (2026-08-28, `0.2.350`, CAP-FB-20260828-NOUN-DISCIPLINE-01)** —
  the sidebar item, the quick drawer, the composer mention group and BOTH `openView` call
  sites for `artifacts/index.html` now say **Artifacts**; the same view no longer has two
  titles. The agent editor's "Core assets" became **Context files** (owner-supplied input
  is not agent output). The hub's Agents card named itself three times nested
  (`aria-label` → `h2` → row); it now names itself once, and the same duplicated
  accessible name was fixed on Recent artifacts and Recent activity. `extension/recipes/`
  is gone (`skills-panel.js` → `extension/skills/`, `recipe-icons.js`/`RECIPE_ICON` →
  `skill-icons.js`/`SKILL_ICON`). Enforced by `npm run check:vocabulary`
  (`scripts/check-vocabulary.mjs`), which scans only user-visible strings and fails the
  build on a banned term — modelled on the `check:gallery` drift guard. Evidence:
  `scripts/kat-noun-discipline.ts` 14/14 in a real loaded extension; the gate observed at
  23 violations on the unfixed tree and 0 after.
- **Per-view nub policy (2026-08-21, CAP-FB-20260819-COVERED-NUB-VISIBILITY-01 provisional 0.2.119 composite)** — the sidebar edge nub is available only where it is actionable: on the hub and in a task/agent conversation it stays visible, enabled, focusable, and in the AX tree; whenever Settings, Directory, Skills, or Assets covers the sidebar, the nub is hidden, inert, disabled, non-hit-testable, non-focusable, and `aria-hidden`. The pure `extension/ntp/view-policy.js` authority never touches collapse state; the broader view policy retains the sidebar's covered inert/AX state. Independently accepted nub/responsive content is recomposed onto transition-focus tip `46a3e6df`, preserving explicit agent composer focus, focus-neutral follow-ups/same-thread opens, Directory trigger restoration, and route-aware snapshots. V4 evidence found real 500px Settings overflow after eight passing cells; the composite reflows every fixed form grid below 680px with 500px/360px semantic contracts and no clipping. Exact composition review and the complete 48-cell plus rapid-sequence browser matrix remain pending.
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
- One conversation-owned run-status surface (the shared `<conversation-run-status>` pixel grid: queued / running / retrying / waiting-for-permission / completed / failed / cancelled + the live tool activity) at the BOTTOM of the thread, below the transcript and above the composer; the legacy top-of-thread banner and the duplicate generic thinking spinner are removed (CAP-FB-20260819-CONVERSATION-RUN-STATUS-01).
- **Run-status lifecycle fence (2026-08-19)** — fixed the repeatedly reported thinking/loading lifecycle bug class on current main: immutable run/surface owner tokens fence every run's status/progress/result rendering and every asynchronous title/status DOM commit against surface switches AND same-surface double-sends; a newly opened thread hides the prior banner at ownership hand-off, before its asynchronous read settles; a follow-up in an already-open thread no longer restarts the view transition (the banner flash); a progress-port disconnect settles the banner instead of sticking on Working; an orphaned "running…" is owner-reset when a surface leaves. Switched-away execution and SW journal persistence are deliberately unaffected. Covered by the loaded-MV3 lifecycle evidence plus the non-browser switched-surface owner regression.
- **No-tools terminal projection ordering (2026-08-21, corrective successor)** — if event-driven terminal reconciliation has already replaced the open transcript from authoritative `thread.get`, the response completion does not append the same assistant result again. The decision is bound to the exact thread, immutable execution, surface owner and render generation and suppresses only byte-identical content; revisions and new attempts remain visible. The loaded-MV3 contract counts assistant bubbles after every conversation journey and rejects adjacent identical results, rather than checking only named-agent completion.
- The subtle timestamps (a muted divider at ≥5m gaps / the first message).
- The readable tool-result summaries (not raw JSON).
- **Structured tool-call renderer (2026-08-18)** — fixed the live raw/double-encoded JSON card with the shared `<message-bubble>` renderer and `extension/shared/tool-tree.js`: bounded never-throw parsing/serialization, canonical secret redaction, UTF-8 byte caps, accessible collapsible key/value rows, copy controls, timing, and terminal error/abort states. Immutable per-run call IDs pair persisted calls/results across reload; failed SDK tool results remain errors; typed aborts stay authoritative and prevent partial success journaling. The deterministic demo provider exercises genuine production tool calls in an actually loaded MV3 extension. The targeted contract is 83 checks (36 tool-tree + 20 lifecycle + 8 terminal + 19 abort); full feature history is preserved by the integration merge, while exact integration-commit commands, screenshots, hashes, and clean-tree state are retained externally for review.
- The comprehensive + actionable error reporting (the underlying reason + category + what-to-do).
- The standalone thinking spinner is removed: thinking progress (with step counts) renders in the single conversation-owned run-status surface instead of a second in-log bubble.
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

### Settings → Agents: per-agent provider/model picker is broken + inconsistent with Providers (Paul, 2026-08-18) — FIXED

**Fix (2026-08-18, branch `provider-model-picker`):** two new shared Web Components in
`extension/shared/components.js` — `<provider-select>` (native base-select styled, labeled,
placeholder="Use the global provider") and `<model-picker>` (ARIA combobox: searchable/filterable
over the SAME `modelsForVendor` catalogue, newest-first; arrows/Enter/Escape/Tab; an unknown
id commits as a first-class CUSTOM value; empty catalogue = free-text mode for Ollama /
OpenAI-compatible) — used by BOTH the per-agent rows and the main Providers section. The agent
row is now a labeled grid (Agent | Provider | Model id | Base URL (openai-compatible only) |
API key | Save) with every control exactly `--input-h` (36px). The stale hand-maintained
openai-compatible model list is gone (free-custom). The override's baseURL is stored
deliberately (preset endpoint, or the explicit field for openai-compatible, prefilled from the
global when it matches); the key stays write-only.

Evidence: before/after CDP screenshots + measured metrics
(`/tmp/cap-picker-audit-*/metrics-audit.json`: select 36px vs inputs 40px, unlabelled →
`/tmp/cap-picker-full-*/`: all controls 36px, labelled). Regression:
`deno run -A scripts/agent-provider-picker.ts` — 27/27 (filter/search, keyboard nav,
global-provider toggle, persistence round-trip, key not echoed, catalogue newest-first,
custom-id fallback, equal heights, Providers reuses the component, stale list gone,
+ the k3 block: provider-card heights, blank-key preservation in the real registry,
Base-URL cell visibility, openai-compatible e2e, focus preservation).
Unit: `deno test -A tests/` 331/331 (incl. `tests/model-picker.test.ts` + the k3
HIGH-1/HIGH-2/redaction/nano-filter tests). Gates: chrome journeys 119/119, gallery
smoke 34/34, security suite 7/7, `check:gallery` no drift. Vision review:
deepseek-v4-pro (PASS; its placeholder-clip finding fixed).

**sol + final review rounds (2026-08-18) — BLOCKS cleared:**
CRITICAL: the test sentinel is GONE from production — the journey builds its own
CAP_TEST_SEAM=1 bundle (build.mjs appends scripts/test-seam.snippet.js only when
the env var is set; the default build hard-fails if it ever ships a seam).
HIGH: provider.get/set are REDACTED (apiKey:"" + hasApiKey; the raw global key
is SW-only — absent-key preservation + clear-key + provider.test all run inside
the SW; conversation surfaces use provider.summary). HIGH: centralized
secret-safe errors — describeError's build() redacts + bounds EVERY output
(reason/message/detail/URLs with query dropped) before routes/threads/logs/
diagnostics; openai-model logs a sanitized bounded URL+body; diagnostics push()
redacts+bounds; the structural regex is boundary-anchored (no tokenCount/
secretary false positives) + case-insensitive + percent-encoded masking +
credential-shape matching (sk-/Bearer/… after a keyword). HIGH: permission race
— one in-flight request per pattern (concurrent callers share it), timeout
never launches a duplicate, late outcomes reconciled + broadcast. MEDIUM: the
journey is fully genuine-CDP now (native select via real click + arrows +
Enter; real typing incl. Ctrl+A+Delete; real Escape; listener-count accounting;
owner-gesture Clear-key control; commit-anchored manifest with console
transcript; responsive no-overflow grid proven at 520px; package-lock synced).
The adapter run is attested FAIL-CLOSED (headless auto-denies the origin
prompt — the gate's correct posture) while provider.test executes its HTTP
path against a real CORS-open local endpoint SW-side. chrome-journeys: 117/119
with the SAME two worker-restart checks failing IDENTICALLY on the pristine
base — retained evidence under test-artifacts/flake-evidence/ (index.json +
summary.json + one FULL log per run: commit, command, timestamp, duration,
every FAIL line). Ancestry honesty: the branch is SEVEN hashes including the
base (six after it), not eight.

**Acceptance round (2026-08-18, b9120317) — BLOCK cleared:** atomic build
publish (build to temp → scan/clean → atomic same-fs rename; a marker-bearing
output can never exist at the production path); build-test destinations
guarded (must resolve inside the system tmpdir — repo/extension/parent/symlink
escapes rejected BEFORE any deletion); the journey's ENTIRE setup inside
try/finally + SIGINT/SIGTERM/unload handlers running the same cleanup, and the
audit-mode exit routes through it (no Deno.exit bypass); isSettingsSender now
URL-parses (exact extension origin + pathname /options/options.html — no
substring spoof); the lease hardened (canonicalized+validated bounded patterns,
EXPIRING recoverable leases — a crashed page can't block an origin, unguessable
owner token required to settle, settled entries deleted, bounded monotonic
generation high-water map; consumers filter broadcasts by pattern AND
generation); exact known secrets masked at ANY length ≥1. Retained exact-HEAD
evidence: test-artifacts/exact-head/{unit,build,gallery-smoke,security-suite,
gallery-drift}.log (356/354-evolution noted below, 34, 7, clean) + the flake
suite re-run at the final HEAD: 8/8 × 119/119 (branch 4 + base 4, full logs in
test-artifacts/flake-evidence/). Picker journey 50/50 (exact-commit manifest).
Current numbers supersede all earlier counts in this entry: journey 50/50,
unit 356/356, gallery 34/34, security 7/7, chrome-journeys 119/119 (×4+×4).
Ancestry: NINE hashes after the base as of 2f7c0c7 (fe5df46 → f5ee223 → 9cea2e0
→ 49f8c24 → 33742da → fcac8da → 2ddc9ff → bd92491 → 2f7c0c7), plus the
one successor acceptance commit on top.

**Acceptance successor round (2026-08-18, review 677ae679) — single source commit:**
temp guard hardened (system tmp ROOT rejected; every destination is a private
mkdtemp child; nearest-existing-ancestor realpath resolution — symlink escapes
rejected before any rm; verified /tmp + repo paths throw, safe default works);
the SW route now THREADS THE OWNER TOKEN into settleLease (the CRITICAL drop
that made every real settlement fail — with a route-shaped integration test);
leases: capacity is BACKPRESSURE (active leases never evicted — churn cannot
duplicate prompts), strict URL-parse canonicalization (userinfo/query/path
rejected), generations persist across settle/expiry/worker-restart (bounded
chrome.storage.session high-water), consumers match the EXACT expected
pattern+generation with tracked+removed listeners (options + conversation,
one per page); journey lifecycle: ONE awaited idempotent cleanup scope (ws
close, chromium kill+status, server stop, BOTH temp dirs with bounded
retries, production rebuild+scan — all steps run despite one failure, 6/6),
signals exit only after awaited cleanup, audit + final exits route through
it, no Deno.exit inside try; build is a TRANSACTION (unique per-run staging
dir, .build.lock concurrency guard — concurrent-build verified, ALL artifacts
(bundles + gallery + changelog) staged before the swaps, per-file
backup/rollback on failure, stale .build-txn-* cleanup, preserved destination
permissions, clear Windows failure); any-length redaction is COLLISION-SAFE
(short known secrets mask only in credential contexts — keyword-adjacent or
Bearer — never as global substrings; prose + prior markers stay readable;
tested). Tracker ancestry corrected. Post-commit external evidence (not
committed): the exact-HEAD run with true start/end timestamps, exact command,
git status/diff snapshot, 4× branch chrome-journeys at the final SHA,
merge-tree/ancestry vs current main.

**k3 review round (2026-08-18, run b5aff36e) — BLOCK cleared:** HIGH-1 blank-key
preservation (setNamedAgentProvider carries the same-provider key when apiKey is
absent — the JSON-serialization-drop chain — and returns the redacted agent);
HIGH-2 openai-compatible is a first-class provider (PROVIDER_IDS,
OPENAI_COMPATIBLE_IDS ×2, PROVIDER_CHOICES; resolvable + honest missing-config
fallback + testable); MEDIUM-1 `.field[hidden]` display fix + journey assertion;
MEDIUM-2 outer duplicate Model label removed (self-labeled component); MEDIUM-3
self-update re-render guard on both components (focus survives change/commit;
journey-asserted); MEDIUM-4 focus populates the listbox before opening; LOWs:
resize/scroll listener cleanup + scroll reposition, Escape truly reverts,
gemini-nano filtered from the cloud catalogue, native change stopped at the
shadow boundary (no double dispatch). The journey's new provider-card height
check ALSO caught a pre-existing 40px input mismatch on the provider cards —
all single-line controls on the page are now exactly the 36px token.

Paul's report: Settings → Agents supports multiple agents + per-agent providers (right), but the
provider/model picker UI looks broken. "Use global provider" is fine. Selecting a different
provider/model override needs a **searchable/filterable Model ID driven by the same maintained
catalogue as Providers** (`modelsForVendor` / llm-prices), and the select vs Model-ID controls have
**mismatched heights**.

Audit findings (verified in the loaded extension, bdbe1f3, 2026-08-18 — measured via CDP,
evidence `/tmp/cap-picker-audit-*/metrics-audit.json` + screenshot):
1. The per-agent **Model id is a bare free-text `<input>`** (`options.js` `renderAgentProviders`) —
   no catalogue, no search, placeholder hard-codes `e.g. deepseek-chat` (stale across providers).
2. The provider `<select>` sits label-less in the row while the Model/API-key inputs carry
   `.field-label`s — MEASURED: the native select renders **36px** while the model/key inputs render
   **40px** in the same `flex-end` row (the mismatched heights), and there is no "Provider" label
   (`selectLabelled: false`).
3. The main Providers model control is a plain non-searchable `<select>` with a Custom… option —
   the two sections share zero code (AGENTS.md heavy-componentization violation) and a catalogue
   model list can't be filtered/typed.
4. The `openai-compatible` preset ships a hand-maintained model list (11 ids) — a stale hard-coded
   catalogue nothing else uses.
5. The agent override silently stores the PRESET baseURL (`preset?.baseURL ?? ""`) — for
   `openai-compatible` that's an empty baseURL even when the global uses a custom endpoint (a
   stale/wrong value by construction).

Fix (planned): shared `<provider-select>` + `<model-picker>` Web Components (single source,
   extension/shared/components.js) used by BOTH sections; searchable catalogue (newest-first),
   accessible combobox semantics, custom-ID path, equal control heights on the design tokens,
   "Use global provider" preserved, key stays write-only, baseURL stored deliberately.

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
