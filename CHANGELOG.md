# Changelog

## [0.2.89] — 2026-08-18
- fix(tool-calls): successor-2 acceptance — delegate_task aborts, no partial journaling, one-step deterministic demo, mode-consistent evidence with image hashes, versions aligned

## [0.2.88] — 2026-08-18
- fix(tool-calls): successor-2 acceptance — delegate_task aborts, no partial journaling, one-step deterministic demo, mode-consistent evidence with image hashes

## [0.2.87] — 2026-08-18
- fix(tool-calls): successor acceptance — byte-bound root strings, canonical redaction, delegation unwrap, no [object Object], complete external evidence

## [0.2.86] — 2026-08-18
- fix(tool-calls): frozen-tip acceptance — JSON-string contract, tiny-cap RangeError, canonical redaction, immutable callIds, per-run returned outcome, external evidence

## [0.2.85] — 2026-08-18
- docs(ui-fixes): record the acceptance round-2 commit hash + exact-HEAD evidence manifest/log

## [0.2.84] — 2026-08-18
- fix(tool-calls): acceptance round-2 — durable per-run abort, guaranteed UTF-8 envelope, distinct same-name callIds, correct duplicates, restored args, exact-HEAD evidence

## [0.2.83] — 2026-08-18
- docs(ui-fixes): record the final-sol acceptance commit + evidence claims in the tracker

## [0.2.82] — 2026-08-18
- fix(tool-calls): final acceptance — abort-authoritative outcome, no-grace terminal, atomic/UTF-8/redacted serializer, deterministic demo tool provider + REAL persisted-thread evidence

## [0.2.81] — 2026-08-18
- chore: keep package-lock version in sync with the post-commit bump

## [0.2.80] — 2026-08-18
- chore: reconcile package-lock.json version with package.json (pre-existing staleness flagged by the sol review)

## [0.2.79] — 2026-08-18
- docs(ui-fixes): record the final-sol corrective commit hash in the tracker

## [0.2.78] — 2026-08-18
- fix(tool-calls): final-sol blockers — terminal arbitration, replay isolation/legacy, bounded never-throws serializer, copy edges

## [0.2.77] — 2026-08-18
- docs(ui-fixes): correct the tool-tree test count (25) — the targeted total is 36 (25 + 11)

## [0.2.76] — 2026-08-18
- docs(ui-fixes): record the sol-review fix commit hash in the tracker

## [0.2.75] — 2026-08-18
- fix(tool-calls): sol-review blockers — working copy buttons, request-path finalization, paired persisted replay, safe public appendTool

## [0.2.74] — 2026-08-18
- fix(tool-calls): k3 MEDIUM findings — phantom duration, error lifecycle, segment paths, a11y roles, defensive safety

## [0.2.73] — 2026-08-18
- feat(tool-calls): structured tool-call renderer — safe bounded parse + collapsible key/value tree

## [0.2.72] — 2026-08-17
- fix(review): GLM + DeepSeek findings — script double-execution claim protocol (one host runs), UTF-8-safe initialAvatar (no btoa crash on CJK/emoji), bounded skill-import (64KiB + http(s) + walk cap), mark buildScriptSrcdoc test-only + constitution sandbox-page exemption, the missing optional_permissions (bookmarks/history/webNavigation/contextMenus/idle/downloads), the constitution sender-check wording, favicons on every page, the light-DOM size smoke assertion

## [0.2.71] — 2026-08-17
- fix(gemini): preserve the thought_signature across the tool-call round-trip

## [0.2.70] — 2026-08-17
- feat(usage): full usage-tracking visibility — getUsage aggregates by provider/model/agent/task/day (the times/dates), the Usage view shows the complete breakdown (summary + by-provider/model/agent/day tables), and the hub shows a usage summary (calls/tokens/cost); + a breakdown unit test. (ntp.js also carries the concurrent review-fixes worker's avatar/script-host edits — interleaved, both valid.)

## [0.2.69] — 2026-08-17
- chore: stop tracking extension/CHANGELOG.md (a build artifact — the build copies CHANGELOG.md into the extension package)

## [0.2.68] — 2026-08-17
- chore(changelog): fill in the changelog from the commit history (no more '(describe the change)' placeholders) + make the bump hook use the commit message

## [0.2.67] — 2026-08-17
- test(named-agents): normalizeCoreAssets bounds/truncation + coreAssets create/update persistence (the rich agent-config dialog's core-asset store)

## [0.2.66] — 2026-08-17
- fix(webmcp): make tool discovery work on any page you visit — a 'Discover this page' flow on the hub (agent.discover-active resolves the active tab's origin, the click requests tabs+scripting+the origin host permission, then enroll-origin registers + injects the discovery scripts) + a self-contained WebMCP fixture server/page + a passing real-browser integration test (9/9)

All notable changes to the Chrome Agent Platform. Semantic versioning: MAJOR.MINOR.PATCH.

## [0.2.63] — 2026-08-17

A full day of feature work + hardening. (The 0.2.1 → 0.2.63 patch range was an artifact of the auto-bump hook bumping on every commit; consolidated here into the meaningful changes, grouped.)

### Added
- The agent model: persistent **named agents** (nano-banana-generated avatars + names), each with its **own OPFS sandbox** (memory + run history + skills + agents.md + a `memory_grep` tool). The master agent (and the user) create/manage/delegate to them; the sidebar shows them; clicking one opens its chat.
- **Independent background agents** — instantiable from the skills, editable, duplicable, with their own OPFS (not the master's).
- The **skills system** (recipes → skills): a skill is INCLUDED in a task (`/skill:<id>` anywhere in the composer), attachable to an agent, schedulable, and **external skills importable** (the chaos skill-loader pattern — GitHub/URL → SKILL.md → installable).
- The **co-do generative-UI** (a `generate_ui` tool → HTML rendered in a sandboxed double-iframe, themed via preference-percolation, saved as a reusable artifact).
- The **agent-generated repeatable JS scripts** (a script store + a sandboxed Web Worker/offscreen execution environment with a controlled API — run repeatedly without re-invoking the model).
- The **side-panel mechanism** (the agent opens + drives a real page via WebMCP) + the **activity-log explorer** (a browsable/searchable per-agent + master timeline) + **per-agent provider config** + an end-to-end task-completion verification test.
- The **artifact gallery** + the **per-agent OPFS memory explorer** (a file-system tree) + the changelog viewer (Settings → About).
- The **BeautifulUI AI-native primitives** as Web Components (loading-state, thinking-trace, tool-chips, task-row, streaming-text, approval-card, prompt-bar).
- **Comprehensive test coverage**: a test suite per tool (browser/management/memory), UI integration tests, an a11y audit, a perf/leak trace, capability-lifecycle tests, and a real-browser OPFS verification.
- The **standing security suite** (`test:security` — network exfil / sandbox escapes / prompt-injection all proven blocked).

### Fixed
- The **WebMCP discovery** (the content scripts now inject + discover in the open tab; both the declared tools AND the inferred `window.*` functions are found).
- The **provider network gate** (the all-optional host permission is requested on the Run gesture / Set / Test — no more "Failed to fetch" / "host permission missing").
- The **provider error UX** (a failed run shows the unwrapped reason + a "Grant network access" button + a "Fix in Settings" link + a provider-status chip in the header).
- The **Gemini 400** (the model id is normalized — "Gemini 3.7 Flash" → `gemini-3.7-flash`).
- The error flood (a circuit-breaker + the real HTTP status logged once) + comprehensive, actionable error reporting.
- The tool output (readable summaries, not raw JSON) + the media attachments (image bytes reach the model + render in the thread).
- The + menu (every option works in the real extension: the tab picker, the screenshot/capture permission flows, the start/stop controls).
- The error console buttons (copy/copy-all/clear no longer close the panel) + the shield permissions (removable).
- The task-list X (hover + delete) + the subtle timestamps + the inline run-status (at the bottom of the conversation).
- The model lists (data-driven from the llm-prices table) + the pricing (cost tracking + spending limits).
- The settings switches (one shared `<switch-toggle>` — the hand-rolled collision) + the hooks matching permissions.
- The mic (the permission requested before recognition; the utterance space-join).

### Security
- The generative-UI sandbox escape (pre-CSP, self-navigation, meta-refresh) closed.
- The named-agent avatar credential leak (a non-Gemini key never reaches Google) fixed.
- The hook recursion terminated + the scoped runs made side-effect-free + the deny-list race closed.

## [0.2.0] — 2026-08-16
### Added
- The component design system (15+ Web Components) + the component gallery on GitHub Pages.
- The master hub management tool suite (16 tools) + artifacts system + master skill + pluggable skills.
- The unified conversational surface (<agent-conversation> with rich message rendering: styled code blocks, structured tool cards, thinking traces).
- Distinct task threads (auto-named, fullscreen continue, per-thread persistence) + the task sidebar.
- The hooks system (the full chrome.* on* event catalog) + the owner-only authoritative deny-list.
- The 27 prompt-in-a-box recipes + background agents (the Sorting Hat) with the base-select picker.
- The error console + the security shield (co-do-inspired transparency).
- Provider "Test connection" buttons (all 7 providers).
- The impeccable design system (paper + petrol-teal, PRODUCT.md + DESIGN.md).

### Security
- All-optional permissions (manifest permissions = []) + no debugger permission.
- The apiKey-leak fix (redactSecrets — credentials never reach the model prompt/journal).
- 27 rounds of independent security/correctness review (sol).

## [0.1.0] — 2026-08-15
- Initial scaffold + the multi-agent hub.
