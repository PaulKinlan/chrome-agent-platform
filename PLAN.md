# Chrome Agent Platform — Plan & Status

The working plan for the fleet. Every agent/session reads this to see what's happening + where things are.

## The project
Chrome as the agent platform: a new-tab agent hub that orchestrates the web with
persistent named agents (each with its own OPFS sandbox), per-site sub-agents (WebMCP
tool discovery), the generative-UI artifacts surface, a skills system, agent-generated
repeatable scripts, and a system-hooks layer — all under an all-optional-permissions
security model. The README is the overview; THIS file is the single source of truth for
what's landed vs what's next.

## Principles (from the 2026-08-15 thread — NON-NEGOTIABLE)
- **Never accept "it serves" as "it works."** Every feature/fix is verified by driving the real behavior in a browser (CDP) with screenshots as evidence. A route returning 200 or a build passing is zero evidence.
- **Independent review before push** — a different model/session reviews the diff + evidence; vision review is one gate, not a substitute for code/security review.
- **Commit locally; push only after review clears.** No pushing skeletons.
- **Real libraries, not patterns.** agent-do is imported, not reimplemented. Providers actually work.
- **Honest absence** — if something can't be verified, mark it unverified; never claim it works.
- **No emoji icons** — inline SVG icons (line-art, currentColor).
- **Modern web guidance** throughout.
- **No external-project references** — usage-logging is an in-repo pattern, not a reference to another project.

## Status (2026-08-17)
- [x] MV3 extension skeleton + NTP hub + side panel + chat + directory + memory explorer
- [x] Real agent-do bundled (esbuild) + process/global shims (SW registers, no errors)
- [x] Provider options — a DEDICATED settings pane (options page): Gemini/OpenAI/Anthropic/DeepSeek/Ollama/Prompt-API/demo, multi-agent (1-vs-N) hub, theme picker (4 themes), scoped browser-control grant, usage log, per-origin memory (Paul 2026-08-15: the inline dropdown was not a config pane)
- [x] Usage logging (per-call token/cost records, 7-day rolling window, aggregation)
- [x] Browser control + event listening (tabs, alarms, capture)
- [x] Recipes (4 pre-baked utility agents) + management tools (create/delete/list agents)
- [x] Glow effect (reduced-motion-aware) + theme picker (midnight/sunlit/neon/terminal, default sunlit) + mood board
- [x] Composer: "+" attach menu (file/audio/video/other), mic with Web Speech Recognition (in-button equalizer, dedup'd), Record audio + Capture camera
- [x] Omnibox integration (keyword → start a task)
- [x] SVG icons (no emoji)
- [x] Side-panel mechanism — the agent opens a real page in chrome.sidePanel + drives it via WebMCP (open_side_panel tool + sidepanel.getTarget/getTools routes) — landed 72e781a
- [x] Activity-log explorer — a browsable/searchable timeline of every agent run (per-agent + master, tool calls/results/errors) — landed ba83236
- [x] End-to-end task completion verification — a task runs a real model + produces a result + usage recorded (the e2e-task test + the real-browser OPFS verification) — landed 690188c + scripts/opfs-real-browser.ts
- [x] Per-agent provider config — an agent can have its own model/provider override — landed 690188c
- [x] The named-agent layer — every agent (named/site/background) its own OPFS sandbox (memory + history + skills + memory_grep); the master manages them — landed f8909c6/e28e600
- [x] The skills system — recipes → skills; a skill is INCLUDED in a task (/skill:<id>), attached to an agent, scheduled, or imported (the chaos skill-loader pattern) — landed f7a49fc
- [x] The co-do generative-UI (generate_ui + sandboxed double-iframe + the artifact system) — landed 7323a4c
- [x] The hooks system (the full chrome.* on* event catalog + the owner-only authoritative deny-list) — landed
- [x] The standing security suite (network exfil / sandbox escapes / prompt-injection blocked) — landed 9da411c
- [x] The component design system (20+ Web Components, the gallery) + the impeccable design (paper/teal, PRODUCT.md + DESIGN.md) — landed
- [x] Chaos-style semver (a post-commit hook auto-bumps the patch version after each commit) — landed
- [x] The BeautifulUI AI-native primitives (loading-state, thinking-trace, tool-chips, task-row, streaming-text, approval-card, prompt-bar) — landed 6adcfe6
- [x] The layered, versioned system-prompt architecture (lib/system-prompts.js — the single composition authority for every run type; lib/runtime-policy.js — the single authoritative protected-constraints source, enforced LAST after full referenced-skill bodies even for foreign caller prompts; Settings → Advanced with the built-in viewer, per-scope append/prepend/replace customization, the built-in-updated keep/reset/diff flow, mandatory mutation CAS + strict store quarantine + coordinated named-agent lifecycle, the context-aware preview, exact generate/stream provider-boundary capture, and unique-execution keyed attestations with versioned rotation/ephemeral labelling) — docs/SYSTEM-PROMPTS.md

## In flight (2026-08-17)
- (none actively blocked — see the known-issues + the UI-fixes tracker for the polish backlog)

## Remaining work (the proactive backlog)
- Remove the Chrome Prompt API + Demo local from the settings provider picker (internal/testing only) — see the task backlog.
- Fix the WebMCP discovery (the inferred + known endpoints) + a real-browser integration test.
- The screenshot / media-capture permission flows (ask-on-need, not fail).
- The UI polish + the review backlog (see docs/UI-FIXES-TRACKER.md + docs/KNOWN-ISSUES.md).
- The extension rename/packaging (still "Chrome Agent Platform").

## Open questions for Paul
- The extension rename/packaging (still "Chrome Agent Platform").

## Feature: Artifacts (Paul 2026-08-16)
Agents create things for the user in the context of a task (generated pages, files, UI, data). We need:
1. **Per-task artifact view** — see the artifacts a task produced, in the conversation.
2. **Master artifacts view in the hub** — all artifacts across tasks/agents.
3. **Use artifacts** — open/preview/use them.
4. **Attach to a new task** — the + button should offer existing artifacts as attachments (so a task can build on a prior artifact).
Artifacts are origin-keyed (per-agent) with a master index. Types: generated page (HTML), file, data, screenshot, UI fragment. This connects to the co-do double-iframe generative-UI work (a generated UI IS an artifact).

## Task backlog (Paul 2026-08-17)
- Remove the Chrome Prompt API + Demo local from the settings provider picker (internal/testing only).
- Fix the WebMCP discovery (the inferred + known endpoints) + integration tests.
- (The UI-FIXES-TRACKER.md has the full UI batch.)
