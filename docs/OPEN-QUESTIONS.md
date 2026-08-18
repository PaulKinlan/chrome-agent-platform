# Open questions for Paul

Resolved answers are recorded here (Paul confirmed each over the course of the build). Remaining open questions are at the bottom.

## Resolved

1. **Agent model** — RESOLVED: a multi-agent hub that fans out to per-site sub-agents. The "Multiple agents" toggle controls 1-vs-N; the hub is modular. (Paul confirmed.)
2. **Consumer view / next-steps tray** — RESOLVED: an inferred "next steps" tray (2-3 useful actions offered after a task, without taking over browsing). (Paul approved; built into the hub.)
3. **Tool approval** — RESOLVED: inferred (window.*) tools require first-run user approval per origin before the agent may call them. (Paul approved; built.)
4. **Memory persistence** — RESOLVED: origin-keyed OPFS (per-origin, one site can never read another). A sync/export (cloud backup) path is a FUTURE option, not in scope now.
5. **MHTML vs screenshots** — RESOLVED: both. Screenshots for the chat strip; MHTML for full-page archives, kept until the user deletes. (Paul decided.)
6. **WASM tool integration** — RESOLVED (direction): start with the WebMCP (window.*) tool inference + approval flow. A minimal WASM tool set with an owner upload mechanism is a FUTURE option (the wasm-vs-js work informs it).
7. **co-do double-iframe generative UI** — RESOLVED: the agent-generated HTML artifact surface is implemented as a sandboxed double iframe with the artifact gallery/viewer.

## Open

8. **Extension name/packaging** — "Chrome Agent Platform" is a placeholder. Rename + package for distribution later (low priority; decide before any public release).
9. **The model for the hub** — Gemini Nano is weak for tool-calling; which provider should be the recommended default for the best experience?
