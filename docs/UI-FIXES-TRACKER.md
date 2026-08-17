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
(none — all tracked items are done as of the items-15-24 batch.)

## Done (items 15-24 batch)
- 15. **Notification permission** — the run-time completion now checks `chrome.permissions.contains({permissions:["notifications"]})` BEFORE `chrome.notifications.create` (the API object is always defined in MV3, so `?.create` being truthy was not proof of the grant — the root cause of Paul's "requires a user gesture" error). ENABLE time (the NTP + Settings toggle gestures) requests the permission so scheduled notifications can work; a denial just skips them.
- 16. **Agent run log / visibility** — `runTask` now journals each tool-call + tool-result into the journal; a `run-log.list` route returns them; the NTP has a new "Recent activity" section (the agents' task/result/tool/screenshot trace, most-recent-first).
- 17. **Delete tasks** — `deleteThread(id)` (atomic index-row + body removal under the thread lock) + a `thread.delete` route + a hover × delete button on each task-list item (keyboard-accessible).
- 18. **+ button more options** — add-tab / add-window / grab-screenshot added to both the `<attach-button>` menu and the legacy composer, wired to `chrome.tabs.create` / `chrome.windows.create` / `chrome.tabs.captureVisibleTab` (graceful permission errors).
- 19. **+ menu: screen recording** — `getDisplayMedia` → MediaRecorder → a video attachment (both surfaces).
- 20. **Favicon 404s** — `<link rel="icon">` added to ntp/options/chat/sidepanel.
- 21. **renderArtifacts fallback** — `?? "Untitled"` / `?? "unknown"` / `?? 0` (no more "undefined · undefined B").
- 22. **Diagnostics panels overlap** — a module-level `openPanels` set: opening one PanelButton closes the others (one floating panel at a time).
- 23. **Composer/conversation light-DOM CSS** — the `<agent-composer>` styles are now tag-scoped (`agent-composer .composer { … }`) so they apply only within the component's subtree (the same collision mechanism as the blank-toggle bug, fixed without moving the controls out of the light DOM). `<agent-conversation>` was already tag-scoped.
- 24. **Docs drift** — DESIGN.md theme names (Sunlit/Midnight/Neon/Terminal) + docs/index.html palette (paper `#f7f6f3` / ink `#1d1b18` / teal `#0e6e63`).

## Evidence (items 15-24 batch)
- `npm test` — 160 passed (added the `deleteThread` unit test).
- `npm run test:components` — 20/20.
- `npm run test:chrome` — 118/118.
- `npm run build` — clean (0 warnings; the gallery re-synced).
- CDP: `run-log` section renders, the favicon link is present, the + menu lists all 7 options (file/record-audio/capture-camera/record-screen/grab-screenshot/add-tab/add-window).

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
25. [DONE — the hub shows only ACTIVE background agents + a "Configure" link (the full catalog/presets live in Settings); empty state links to Settings] **Agents panel: only ACTIVE background agents** — the NTP agents panel shows ONLY the enabled/running background agents (with a disable option) + a "configure in Settings" link (to add more/the presets). NOT a list of every disabled agent.
26. [DONE — the task sidebar persists inside a thread (the thread-view is offset right of the sidebar; the current thread is aria-current); the + button returns to the hub + focuses the composer; the collapse chevron moved to the sidebar FOOT (was overlapping the heading)] **The task sidebar persists inside a task + the collapse chevron position** — when inside a single task, the sidebar stays visible (all tasks listed, the current one clearly selected); the + button takes you back to the NTP to start a new task. AND the collapse chevron should be near the BOTTOM of the sidebar (it's at the top overlapping the heading — messy).
27. [DONE — omnibox landed (the "agent" keyword, suggestions, Enter runs the task)] **Omnibox command** — the original plan had an omnibox keyword (chrome.omnibox): type the keyword in the address bar → invoke the agent (suggestions + a default action that opens the hub/a thread with the query). Not implemented.
28. [DONE — the shield/console panels (PanelButton) use CSS anchor positioning (anchor-name + position-anchor + position-area bottom span-right + position-try-fallbacks flip-block/flip-inline) so they scroll with the trigger + stay in-bounds; the JS _position() is a no-op when native anchor positioning is supported] **All popovers use anchor positioning (a STANDARD)** — the shield/console popups are not anchored to their buttons (they stay on top when scrolling). Anchor EVERY popover to its trigger (CSS anchor-positioning), so it scrolls with the button + stays in-bounds. Standard: any popover uses anchor positioning.
29. [DONE — collapsed-sidebar tooltips + icon buttons landed] **Collapsed sidebar: tooltips + icon buttons** — a better collapsed-sidebar (the sessions/tasks as icons with hover TOOLTIPS showing what they are; the recipes/directory/settings buttons stay visible as icons).
30. [DONE — the ready indicator removed (cleaner header)] **The "ready" indicator** — is it needed (given the terminal/error badge)? Simplify the header.
31. [DONE — the per-provider model selector landed (dropdowns + OpenAI-compatible + custom)] **A better per-provider model selector** — a dropdown of known models per provider (not a wrong "gpt-4o-mini" placeholder everywhere); an OpenAI-compatible URL option with a model dropdown (Kimi, DeepSeek, etc.) + a user-addable custom model; keep the base default. Bedrock-style configurability.
32. [DONE — chaos-style semver landed (scripts/bump-version.mjs + the version shown)] **Chaos-style semantic versioning** — match the chaos extension's semver mechanism.

## The + menu options are broken in the real extension (Paul 2026-08-17) — test in the REAL extension, not just the gallery
33. **Add tab opens a NEW tab instead of letting you PICK a tab** — should show a tab picker (a list/arrow through the open tabs) + attach the selected tab's CONTENTS.
34. **Grab screenshot errors** (activeTab/URLs permission required) — should REQUEST the permission (a gesture) then capture.
35. **Add window opens a NEW window** instead of adding the current window's contents — remove it OR make it add the current window's tabs' contents.
36. **Record screen has no start/stop UI** — it should show a recording state + a stop control.
37. **Capture camera: videoCapture permission denied** — the permission request isn't working (request videoCapture on the gesture).
38. **Record audio: audioCapture permission denied** — same (request audioCapture on the gesture).
39. **The + menu permissions aren't managed** — each option must request its permission properly + work. DEEP-test each in the REAL extension.

## URGENT interaction bugs (Paul 2026-08-17) — scale out, fix fast
40. **The error-console buttons CLOSE the console instead of working** — clicking copy-all / copy / clear closes the panel (the button click is treated as an outside-click-to-close). The buttons must WORK (copy the line, copy all, clear) WITHOUT closing the console.
41. **The security-panel permission toggles do nothing** — toggling/removing a granted permission doesn't work (asked before).
42. **Task errors aren't logged to the task** — when a task errors, the task shows red but no error detail; the errors must be logged to the task (a detailed error view per task).

## Paul batch (2026-08-17 13:22) — state management + agent chat + task polish + console errors
43. **Click an agent in the sidebar → chat with it** — start tasks directly in that agent + see its log + run history (not just go to the directory).
44. **A site with no WebMCP tools should NOT be an enrolled agent** (paul.kinlan.me has zero tools — don't enroll it).
45. **Task title too long → over two lines** — single line with an ellipsis (+ scroll/show on hover).
46. **A weird empty "run status" div at the top** when opening a task — hide it when empty.
47. **Edit the task title** (click + rename).
48. **STATE MANAGEMENT BROKEN** — clicking a task then agents → the task still overlays the directory. The views must replace each other: the sidebar always visible, the inner content swapped (task/agent/recipes/directory replace each other; settings is a separate view). Fix the stacking/layering.
49. **Console errors to deep-investigate:** "transition aborted: invalid state snapshot; Capture failed" (frequently) + "hook.tabs.onUpdated run failed: No output generated" (all the time). Find the root cause + fix.
50. **Tests must check the console log for errors** (a journey fails if the console has errors).

## Paul error batch (2026-08-17 15:57) — more coming in follow-ups
51. **The Browser-control toggle never stays toggled** (even when enabled) + the allowed-origins grant doesn't persist (a global all-origins grant isn't kept). The toggle/grant state doesn't persist.
52. [DONE — the + menu anchors to the + button (block-start span-inline-end + flip) and never scrolls the frame] **The + menu anchor + the bizarre scroll position** (the mainframe scrolls weirdly when the + menu opens — the anchor + the scroll container issue).
53. [DONE — click an artifact → an <agent-dialog> with the live render (html iframe / image / text)] **Click an artifact → expand + view it** (a dialog/full view) — the Recent artifacts on the NTP should let you click an artifact + expand it in a view dialog.
54. [DONE — the artifacts gallery + viewer no longer double up their back/h1 with the overlay header (a logo only)] **The artifacts panel has a double header (two back buttons + two "artifacts" titles)** — a mess; fix the single clean header/back.
55. [DONE — the named-agent row is fully clickable (an open chevron → openAgentChat: history + run log + talk)] **Click a named agent → its view (history + log) + talk to it** (from the NTP agents panel).
56. [DONE — background agents are duplicable + editable (recipe.duplicate/update/delete; the built-in template stays pristine; a custom copy's prompt is editable)] **Background agents + recipes: editable + duplicable** — talk to one to refine it (does talking to dedupe-tabs change it? work it out); duplicate + edit over time.
57. [DONE — the Recent activity shows WHICH agent did it (the <activity-explorer> agent column from activity.list)] **The Recent activity must show WHICH agent did the activity** (the agent attribution).
58. [DONE — the Data & memory OPFS explorer browses every agent (master/named/background/site); Disenroll moved to the Agents section] **Data & memory section: an OPFS memory viewer + per-agent** — a KEY requirement. Browse the OPFS data/memory (the keys/values, the journals, the artifacts), PER-AGENT (named, background, site — each its own view, not just site agents as one). The "Disenroll" action doesn't belong in Data & memory (remove it).
59. **The OPFS explorer should be a file-system explorer** (an expandable directory tree, files clickable to view) — not a flat list.
60. **The browser-control toggle STILL not working** (item 51's fix didn't fully land — double-check in the real extension + fix the real cause).
61. **Background agents are INDEPENDENT agents** — clickable (their view/log/history + talk to them), instantiable from the recipes (multiple of the same), editable, and INDEPENDENT of the master hub (their own OPFS data/memory, in the Data & memory explorer as their own agent).
62. **The media bytes must reach the model** (an attached image → an image part in the model input, multimodal — not a text note).
63. **The attachment must display in the conversation** (an inline image/audio/video preview or file chip).

## Paul batch (2026-08-17 18:59) — the autocomplete + the X button + the remaining UI issues
62. **The / autocomplete is broken around the edges** — typing /s should filter to schedule/skill (a live filter); /skill: should list ALL the skills (autocomplete); /task shouldn't be there (it's /skill now — recipes are gone); the popover flips above/below + scrollable. Make the / autocomplete actually useful.
63. **The @ autocomplete** — list all agent types (named + background + site, delineated).
64. **The X close button on the task list is broken** (still not fixed — verify + fix the delete).
65. **Reconcile: go through everything Paul listed in the past 1-2 hours + verify each is fixed** (the tracker items) — mark the genuinely-done + fix the rest.
