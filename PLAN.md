# Chrome Agent Platform — Plan & Status

The working plan for the fleet. Every agent/session reads this to see what's happening + where things are.

## Principles (from the 2026-08-15 thread — NON-NEGOTIABLE)
- **Never accept "it serves" as "it works."** Every feature/fix is verified by driving the real behavior in a browser (CDP) with screenshots as evidence. A route returning 200 or a build passing is zero evidence.
- **Independent review before push** — a different model/session reviews the diff + evidence; vision review is one gate, not a substitute for code/security review.
- **Commit locally; push only after review clears.** No pushing skeletons.
- **Real libraries, not patterns.** agent-do is imported, not reimplemented. Providers actually work.
- **Honest absence** — if something can't be verified, mark it unverified; never claim it works.
- **No emoji icons** — inline SVG icons (line-art, currentColor).
- **Modern web guidance** throughout.
- **No chaos references** — the usage-logging is a pattern, not chaos.

## Status (2026-08-15)
- [x] MV3 extension skeleton + NTP hub + side panel + chat + directory + memory explorer
- [x] Real agent-do bundled (esbuild) + process/global shims (SW registers, no errors)
- [x] Provider options (Demo / OpenAI-compatible / Prompt API) — config in hub settings
- [x] Usage logging (chaos-extension pattern: per-call token/cost, 7-day window, aggregation)
- [x] Browser control + event listening (tabs, alarms, capture)
- [x] Recipes (4 pre-baked utility agents) + management tools (create/delete/list agents)
- [x] Glow effect (reduced-motion-aware) + theme picker (midnight/sunlit/neon/terminal, default sunlit) + mood board
- [x] Composer: "+" attach menu (file/audio/video/other), mic with Web Speech Recognition (in-button equalizer, dedup'd), Record audio + Capture camera
- [x] Omnibox integration (keyword → start a task)
- [x] SVG icons (no emoji)
- [ ] Side-panel mechanism (open the real page in chrome.sidePanel / background tab + postMessage, drive via WebMCP) — STEERED, in flight
- [ ] Activity-log explorer (JSONL per agent + master, browsable/searchable) — STEERED, in flight
- [ ] End-to-end task completion verification (a task runs a real model + produces a result + usage recorded)
- [ ] Per-agent provider config (TBD)

## Open questions for Paul
- The provider default for a real model: Prompt API (on-device) vs a configured endpoint. Which?
- The side-panel vs background-tab choice for driving pages (worker is evaluating).
