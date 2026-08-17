# Changelog

## [0.2.64] — 2026-08-17
- (describe the change)

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
