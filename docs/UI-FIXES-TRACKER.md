# UI Fixes Tracker — Paul's asks (each tracked to completion)

Discipline: every Paul ask → an entry here → a subagent fixes + VISUALLY verifies (screenshot before/after) → checked off. Nothing dropped.

## Done

1. **Settings: duplicate back buttons** — removed the bottom "Back to hub" (`#open-hub` in `.side-foot`); the settings page no longer has a redundant bottom button. Verified: `openHub === false`, `sideFoot === false` via CDP.
2. **Agents "Multiple agents" toggle mess** — root cause: the options page used a hand-rolled `<label class="switch">` + native `<input type="checkbox">` whose `.switch` class COLLIDED with theme.css's `.switch` (the label got forced to 36×20 + a `::after` knob, producing the "double toggle" + text overlap). Replaced with the shared `<switch-toggle>` Web Component + a `.toggle-field` grid (switch | stacked name+description). Verified: one `.sw` track (no double), click toggles checked, no horizontal overlap.
3. **Browser control toggle + origins** — same `<switch-toggle>` + the allowed-origins textarea now `width:100%` (stretches the full panel content width). Verified.
4. **System hooks must match permissions** — the hooks now render with the SAME `.perm-row` class + grid as the Permissions section (one layout), and the hook id is folded into the hint (no extra column). Verified: hooks + permissions share the same `.perm-row` grid; denying a hook does NOT change the row height (75.27px before == after) — no layout shift.
5. **One shared toggle everywhere** — extracted the canonical `<switch-toggle>` Web Component (track + knob, `role="switch"`, self-managing `checked`) into `shared/components.js`; refactored `<capability-row action="toggle">` to use it; the settings (multi-agent / browser-control / background-agents) all use it. The stale native-checkbox `.switch`/`.track` CSS + the `.hook-row`/`.hook-id` CSS removed.

## Open
- (none outstanding for this batch)

## Evidence
- `npm test` — 151 passed.
- `npm run test:components` — 16/16 (updated the capability-row assertion for the switch-toggle).
- `npm run test:chrome` — 118/118 (scoped the permissions capability check to `#permission-list`).
- CDP-driven: single switch track, no toggle/desc overlap, hooks height stable on deny, back button removed, origins full-width.
14. **Error console: copy buttons not working + errors not surfaced** — each log line needs a WORKING copy button + a "Copy all" at the top (asked before, not landing). AND the console shows warnings but NOT the actual error text (the SW API errors, console.error, AI errors) — capture + surface the real errors prominently (a distinct error level, the full error message + stack).
15. **Notification permission gesture error** — a background agent tried to request the notifications permission WITHOUT a user gesture (the browser rejected it). Background agents must NOT request permissions at run time; the permission must be granted at ENABLE time (a gesture) or the notification skipped gracefully.
16. **HARD CONSTRAINT: agent run log / visibility** — Paul cannot see the background agents he created (not in the directory, not in the site-agent panel) AND cannot see the agent run LOG/TRACE (what the agent did — the tool calls, the errors). If an agent runs in the background, the user MUST be able to SEE it + its run log. Build: an agents view (all agents — background + site) + a per-agent run log (the journaled tool calls/results/errors, viewable).
17. **Delete tasks** — a delete affordance on the task-list (sidebar) items (remove a one-shot/errored task).
18. **+ button more options** — add tab, add window (target a specific window), grab a screenshot (plus the existing file/audio/camera).
