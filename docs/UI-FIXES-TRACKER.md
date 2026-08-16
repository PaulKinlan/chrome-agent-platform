# UI Fixes Tracker — Paul's asks (each tracked to completion)

Discipline: every Paul ask → an entry here → a subagent fixes + VISUALLY verifies (screenshot before/after) → checked off. Nothing dropped.

## Done

1. **Settings: duplicate back buttons** — removed the bottom "Back to hub" (`#open-hub` in `.side-foot`).
2. **Agents "Multiple agents" toggle mess** — root cause: a hand-rolled `<label class="switch">` collided with theme.css's `.switch`. Replaced with the shared `<switch-toggle>` Web Component + a `.toggle-field` grid.
3. **Browser control toggle + origins** — same `<switch-toggle>` + the allowed-origins textarea `width:100%`.
4. **System hooks must match permissions** — hooks render with the SAME `.perm-row` grid as permissions; denying a hook no longer changes row height.
5. **One shared toggle everywhere** — the canonical `<switch-toggle>` Web Component extracted; all settings use it.
6. **Task sidebar expand/collapse** — a `.side-toggle` collapses the sidebar to a 60px icon rail (text hidden) + expands back; the `aria-expanded` state is kept.
7. **Empty task list "+" button** — a `#new-task` "+" button in the sidebar header focuses the composer (fixes "start above" with nothing above).
8. **View Transitions** — `withViewTransition()` wraps the thread open/close, the in-context view open/close, and the sidebar collapse (a named `overlay-view` transition element); no-op when the API is absent or `prefers-reduced-motion` is on.
9. **Render HTML output as HTML** — `isHtmlDocument()` detects full documents + block-level fragments; `renderHtmlFrame()` renders them in a SANDBOXED `<iframe sandbox="allow-scripts allow-popups">` (the co-do double-iframe pattern). Non-HTML stays markdown.
10. **Provider "Test connection" button** (separate commit) — a real minimal round-trip + specific error mapping.
11. **A unified "Agents" area on the NTP** — one "Agents" panel with two groupings: "Background agents" (from `background-agent.list`, toggle to enable/disable + "every N min") and "Site agents" (enrolled origins); a combined `agent-count`.
12. **+ menu options work + in-bounds** — removed the duplicate "Add other file" + the stale "media not sent" note; the menu uses `popover="manual"` + CSS anchor positioning (`position-area` + `position-try-fallbacks`) with a `placeFloating()` JS fallback.
13. **@mention / command popup anchor-positioning** — the composer `.popup` anchors to the composer + flips above/below via `position-try-fallbacks: flip-block` (JS fallback `placeFloating`).
14. **Error console copy buttons + surface errors** — a per-line Copy button + a header "Copy all"; entries sorted errors-first (newest within level) + a `source` column + errors tinted with the danger color.

## Open
- 15. **Notification permission gesture error** — a background agent tried to request the notifications permission WITHOUT a user gesture. Permission must be granted at ENABLE time (a gesture), or the notification skipped gracefully.
- 16. **Agent run log / visibility** — an agents view (all agents — background + site) + a per-agent run log (journaled tool calls/results/errors, viewable).
- 17. **Delete tasks** — a delete affordance on the task-list sidebar items.
- 18. **+ button more options** — add tab, add window, grab a screenshot.
- 19. **+ menu: grab a screen recording** — tabCapture/getDisplayMedia → MediaRecorder → a video artifact.

## Evidence (this batch)
- `npm test` — 156 passed.
- `npm run test:components` — 20/20 (added HTML-iframes + copy-all checks).
- `npm run test:chrome` — 118/118.
- CDP-driven: collapse button + new-task button present, collapse toggles, `background-agents` + `site-agents` sections render, `@mention` popup opens, `[data-copy-all]` present.

## DeepSeek-v4-pro vision review (HEAD 4819314) — 5 LOW defects (no blockers)
Verified working: the threads feature end-to-end, the toggles (the blank-toggle bug fixed), the conversation (code blocks, tool cards, thinking), the diagnostics, the palette (clean paper/teal, zero slop). Defects:
20. Favicon 404s on every extension page (no <link rel="icon">).
21. renderArtifacts no fallback (a malformed asset renders "undefined · undefined B" — use ?? 'Untitled').
22. The diagnostics panels (error-console + security-shield) overlap when both open (no close-others logic).
23. agent-composer + agent-conversation use light-DOM with document-scope CSS (the same mechanism as the blank-toggle bug — use adoptedStyleSheets so they are light-DOM but self-styled).
24. Docs drift: DESIGN.md lists the wrong theme names; docs/index.html uses the old slop palette.
(Recommend: fold a keyboard Tab-order sweep + a prefers-reduced-motion check into the smoke test — constitution §2.)
25. **Agents panel: only ACTIVE background agents** — the NTP agents panel shows ONLY the enabled/running background agents (with a disable option) + a "configure in Settings" link (to add more/the presets). NOT a list of every disabled agent.
26. **The task sidebar persists inside a task + the collapse chevron position** — when inside a single task, the sidebar stays visible (all tasks listed, the current one clearly selected); the + button takes you back to the NTP to start a new task. AND the collapse chevron should be near the BOTTOM of the sidebar (it's at the top overlapping the heading — messy).
