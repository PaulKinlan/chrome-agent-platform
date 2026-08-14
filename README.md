# Chrome Agent Platform

Chrome as the agent platform: a MV3 extension whose new-tab page is the **agent hub**. The
user starts tasks (text/image/audio/video); the agent opens web pages in a side panel and
orchestrates them via WebMCP. Sites with WebMCP/MCP tools become callable agents; sites
without get an inferred tool profile. Includes sites-as-sub-agents (per-origin
context/journal/skills), OPFS memory (master + per-agent + explorer), an alarm scheduler
(agent-do/chaos), double-iframe content morphing, co-do WASM tools, and a chat surface with
screenshot/MHTML history.

## Status
- [x] `docs/DESIGN.md` — the architecture
- [x] `mock/` — static UI mockups for review (ntp-hub, chat, directory, memory)
- [x] `extension/` — MV3 scaffold (manifest + module stubs)
- [ ] full build (after design/mock review)

## Review the mock UI
```sh
cd mock && python3 -m http.server 8000
# open http://localhost:8000/
```

## Open questions
See `docs/OPEN-QUESTIONS.md`.
