# Chrome Agent Platform — UX / Navigation / Performance / Memory Audit

**Audited at:** 2026-08-28T10:38:01.091Z · **Target:** the built MV3 extension (v0.2.329 build loaded via `--load-extension`, chrome-extension:// pages driven over raw CDP; the audited build includes in-flight worktree changes beyond commit 2fc8bc1b)
**Method:** web-uplift fully-agentic methodology (17 principles, evidence-first, zero hard-coded checks) adapted to extension form factor. Evidence: screenshots (normal / 360px narrow / prefers-color-scheme dark per surface), layout metrics (overflow, CLS, long tasks), DevTools trace on cold load, CDP Performance.getMetrics leak-hunts, axe-core 4.10, focus/keyboard probes, hostile-input probes.

## Coverage

- **ntp-firstrun** — `chrome-extension://<id>/ntp/ntp.html` — first-run state (fresh profile) — the highest-traffic first journey
- **ntp-hub** — `ntp/ntp.html (hub)` — the default landing surface
- **ntp-panels** — `ntp/ntp.html #view=options|directory|artifacts` — iframe panel views (settings/directory/assets) — the leak + navigation surfaces
- **ntp-360** — `ntp/ntp.html @360x800` — narrow form factor (sidepanel-adjacent usage)
- **options-sections** — `options/options.html (13 sections)` — settings inventory incl. providers/permissions/tool-library/usage
- **sidepanel** — `sidepanel/sidepanel.html` — the narrow-native surface
- **artifact-viewer** — `artifact/artifact.html (no-id, hostile-id, deep link)` — 0.2.318 new-tab artifact flow + security re-check
- **assets-library** — `artifacts/index.html` — artifact library page
- **directory-page** — `directory/directory.html` — site-agent directory page
- **Not covered (honest):** A task thread WITH real history could not be seeded: no provider credentials in the clean profile, the built-in demo model returned no content in two attempts, so thread-open timing (the 0.2.317 bounded-replay fix) is NOT re-verified end-to-end here; the empty thread/tasks states were audited instead. Service-worker + shared-worker heaps were not profiled (page-level metrics only).

## Scorecard (hand-built; web-uplift scorecard.mjs expects a website host)

| Outcome | Status |
|---|---|
| respect-user-preferences | issues |
| implement-natural-interactions | pass |
| provide-guided-navigation | issues |
| maximize-content-reduce-noise | pass |
| adapt-to-the-form-factor | issues |
| support-core-task-success | issues |
| be-fast-and-stable | pass |
| be-inclusive | issues |
| follow-best-practices | pass |
| be-discoverable | not-applicable |
| be-private-and-secure | pass |
| be-resilient | pass |
| be-internationalised | not-applicable |
| be-trustworthy | issues |
| be-sustainable | pass |
| be-agent-ready | pass |
| be-memory-efficient | issues |

**11 findings — 4 high · 4 medium · 3 low. Top-3 do-these-first:** ① panel iframe/listener leak (UX-001/002) ② dark scheme (UX-003) ③ 360px overflow (UX-004).

## Findings (prioritised)

### UX-001 · high · be-memory-efficient/no-leak-under-repeated-interaction

Settings/directory/assets panels leak their iframe documents and frames on repeated open/close: Documents 12→33 and Frames 11→21 after 20 open/close cycles (Performance.getMetrics); close-button path alone: Documents 5→15, Frames 3→8 after 5 closes.

**Evidence:** CDP Performance.getMetrics before/after repeated panel cycles (memory2.json, leak-compare.json). Heap grew 3.2MB→7.2MB over the same window.
**Artifacts:** `evidence/leak-compare.json`
**Fix:** On panel close, remove the iframe from the DOM and null its src (or reuse a single persistent frame per view); audit the panel-close path for retained frame owners (the view wrapper keeps references after hide). (effort M, confidence high)

### UX-002 · high · be-memory-efficient/no-detached-dom-or-unbounded-listeners

Event listeners accumulate on panel open/close: JSEventListeners 113→334 after 5 open/Escape cycles, and 240→479 over the 20-cycle sweep — listeners are added per open and never removed.

**Evidence:** CDP Performance.getMetrics (leak-compare.json, memory2.json).
**Artifacts:** `evidence/leak-compare.json`
**Fix:** Wire panel-scoped listeners with AbortController/once and tear them down on close; verify with the same metrics probe (listener count must return to baseline after close). (effort M, confidence high)

### UX-003 · high · respect-user-preferences/respects-color-scheme

No surface responds to prefers-color-scheme: dark — every audited page keeps the light palette (body bg rgb(247,246,243)) under OS dark mode: NTP (all views), options, sidepanel, artifact viewer, artifacts library, directory.

**Evidence:** Emulated prefers-color-scheme: dark screenshots + computed body background on every surface (surfaces.json darkSample; *-dark.png artifacts).
**Artifacts:** `evidence/ntp-hub-dark.png`, `evidence/options-dark.png`, `evidence/sidepanel-dark.png`, `evidence/artifact-noid-dark.png`, `evidence/view-assets-library-dark.png`
**Fix:** Add a dark scheme to the single design system (theme.css): define tokens with light-dark() or a prefers-color-scheme media query; audit contrast in both schemes. Context: theme switching was deliberately removed, but OS-level scheme respect is a user preference, not a theme switcher. (effort L, confidence high)

### UX-004 · high · adapt-to-the-form-factor/responsive-no-horizontal-scroll

Horizontal overflow (16px) on every NTP surface at 360px (hub, first-run, and the settings/directory/assets panels): the fixed 240px sidebar rail is not auto-collapsed at narrow widths, leaving ~120px of content column; the first-run card wraps one word per line and clips at the right edge.

**Evidence:** layoutMetrics overflowX=16 at 360x800 on ntp-firstrun/hub/chat/directory/settings (surfaces.json); ntp-hub-dark.png (captured at 360px) shows the clipped card.
**Artifacts:** `evidence/ntp-hub-dark.png`, `evidence/ntp-firstrun-narrow.png`, `evidence/ntp-hub-narrow.png`, `evidence/ntp-settings-narrow.png`
**Fix:** Auto-collapse the rail below 600px (matchMedia listener + the existing collapsed state), or convert it to an overlay drawer; re-run the 360px overflow probe (target 0). (effort M, confidence high)

### UX-005 · medium · support-core-task-success/clear-system-state-and-recovery

The first-run guide's primary CTA ("Use starter task") renders disabled with no accessible reason: no title, no aria-disabled, no aria-describedby; storageReady/providerReady gating is invisible to the user and to assistive tech.

**Evidence:** first-run-guide shadow DOM probe (leak-compare.json cta): {disabled:true, title:null, ariaDisabled:null, describedBy:null, storageReady:false, providerReady:false}; ntp-hub-normal.png shows the greyed button.
**Artifacts:** `evidence/ntp-hub-normal.png`
**Fix:** When gated, keep the button enabled-looking but present the reason inline ("Configure a provider to unlock") or set aria-describedby pointing at the gating explanation; also expose it as a status line so screen readers announce it. (effort S, confidence high)

### UX-006 · medium · be-inclusive/names-roles-labels

axe-core violations on primary surfaces: aria-allowed-attr (1 node on NTP; 3 on options pages — elements with unsupported ARIA attributes), landmark-unique (NTP), nested-interactive (NTP panels), scrollable-region-focusable (options), landmark-one-main + region role issues (sidepanel, artifact viewer).

**Evidence:** axe.run() on ntp/options/sidepanel/artifact (surfaces.json axe blocks); passes 38 on NTP.
**Artifacts:** `evidence/ntp-hub-normal.png`
**Fix:** Fix the aria-allowed-attr elements first (critical impact), give duplicate/nested landmarks distinct accessible names, make scrollable regions tabbable (tabindex=0 + label). (effort S, confidence high)

### UX-007 · medium · be-inclusive/structure-and-focus

No level-one heading on the NTP (page-has-heading-one; heading order starts at H2: Agents / Recent artifacts / Recent activity) — the page title lives in <title> only.

**Evidence:** axe violation page-has-heading-one; headingOrder probe (keyboard.json).
**Artifacts:** `evidence/ntp-hub-normal.png`
**Fix:** Add a visually-integrated h1 (e.g. "Agent Hub") or promote the brand element to h1; keep the visual design unchanged. (effort S, confidence high)

### UX-008 · medium · be-trustworthy/humane-error-handling

A run that fails before dispatch (no provider configured; demo model returned no content) leaves NO trace in Tasks (task.list stays empty) — the user's submit silently produces nothing persistent; recovery requires re-entering the prompt.

**Evidence:** seed.json + run2.json: named-agent.run → {ok:false,error:"the model returned no content"} and the composer run probe → tasks:[], runs:[] with no visible status on the surfaces probed.
**Artifacts:** `evidence/fail-probe.png`
**Fix:** Persist failed dispatches as a task row with an explicit failed state + Retry, or surface an inline persistent error card in the thread area. (Medium confidence: probes may have missed transient status text.) (effort M, confidence medium)

### UX-009 · low · support-core-task-success/clear-purpose-and-primary-action

The artifact viewer's "Copy content" action is enabled even in the error state (no artifact id given) — a dead primary-adjacent action on the failure path.

**Evidence:** artifact-noid-normal.png: error text "No artifact id given." with an enabled Copy content button; hostile-id render confirmed inert (imgs:0 bold:0 — the 0.2.318 escaping fix holds).
**Artifacts:** `evidence/artifact-noid-normal.png`, `evidence/artifact-hostile.png`
**Fix:** Disable Copy content (and Back-only layout) until an artifact resolves. (effort S, confidence high)

### UX-010 · low · adapt-to-the-form-factor/component-level-responsiveness

The hub content column is hard-capped at max-width:680px, leaving ~700px of dead margins at 1440×900; the settings panel shows the same 680px column inside a full-viewport iframe. Content is not harmed, but the hub reads sparse and panels waste half the dialog.

**Evidence:** ntp.html .main-wrap{max-width:680px} + ntp-hub-normal.png / panel-settings.png at 1440px.
**Artifacts:** `evidence/ntp-hub-normal.png`, `evidence/panel-settings.png`
**Fix:** Let the hub grid use the available width (e.g. 2-column agent/activity layout ≥1100px) or cap at ~960px; consider widening the settings column to ~840px. (effort M, confidence medium)

### UX-011 · low · support-core-task-success/clear-purpose-and-primary-action

Sidepanel first-run is extremely sparse: a wrapped "Side panel" label, one URL row, and a one-line hint over an empty viewport — no guidance about what Site Agents do or what to do first; landmark-one-main + region axe violations.

**Evidence:** sidepanel-narrow.png / sidepanel2.json (text + interactive inventory); axe violations landmark-one-main, region:2.
**Artifacts:** `evidence/sidepanel-narrow.png`, `evidence/sidepanel-normal.png`
**Fix:** Add a compact getting-started block (what Site Agents are, one example) and fix the label/landmark structure. (effort S, confidence medium)

## Verified-good (no action)

- **Performance:** NTP cold load FCP 24.4ms / DCL 38.3ms, zero long tasks in the 6s trace; CLS 0 observed across surfaces; zoom 200% reflows with no horizontal overflow.
- **Console hygiene:** zero console errors/exceptions across 12+ surfaces and all emulated conditions.
- **Security posture:** web_accessible_resources stays minimal (artifact viewer + sandbox frame only); hostile-id deep-link renders inert text (the 0.2.318 escaping fix verified live); provider-key story stated in-product; no third-party page requests.
- **Settings back-stack:** section nav is replaceState by design — one back press exits settings to the landing section (verified: #appearance → back → #about).
- **Reduced motion:** respected (media query + matchMedia gate); Escape closes panels; sidebar collapse state persists.
- **Empty states:** tasks / artifacts / activity / directory are honest and give a next action.

## Task list (highest leverage first)

1. **Fix the panel iframe/listener leak: release or reuse frames on close; tear down listeners (AbortController); verify with the metrics probe (Documents/Frames/JSEventListeners return to baseline).** (M; findings UX-001, UX-002)
2. **Add a prefers-color-scheme: dark scheme to the single design system (light-dark() tokens + contrast audit in both schemes).** (L; findings UX-003)
3. **Kill the 360px overflow: auto-collapse the sidebar rail <600px (or overlay drawer); re-probe overflowX=0 on all NTP surfaces.** (M; findings UX-004)
4. **Make the first-run CTA gating visible: inline reason + aria-describedby; keep the numbered steps as the anchor.** (S; findings UX-005)
5. **Persist failed dispatches as visible, retryable task rows (or a persistent inline error card).** (M; findings UX-008)
6. **Clear the axe violations: aria-allowed-attr (critical) on NTP + options, landmark names, tabbable scrollable regions, add an H1.** (S; findings UX-006, UX-007)
7. **Artifact viewer: disable Copy content in the error state.** (S; findings UX-009)
8. **Wide-viewport density: hub ≥1100px two-column (or 960px cap); widen the settings column inside panels.** (M; findings UX-010)
9. **Sidepanel getting-started block + landmark fixes.** (S; findings UX-011)

## Raw data

- `report.json` (schema-shaped) · `evidence/` (53 PNGs + JSON probes) · memory2.json / leak-compare.json (leak numbers) · perf.json (trace summary) · surfaces.json (per-surface metrics).