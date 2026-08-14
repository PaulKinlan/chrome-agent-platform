# agent/ — the agent core (stub)

- `planner.js` — intent → plan → tool calls
- `registry.js` — sites-as-sub-agents registry (per-origin context/journal/skills)
- `tool-directory.js` — declared (WebMCP) + linked (agent.md/skills) + inferred (window.*) tools
- `memory.js` — OPFS master + per-agent memory
- `morph.js` — double-iframe content morphing
