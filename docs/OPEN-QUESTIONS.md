# Open questions for Paul

Resolved answers are recorded here (Paul confirmed each over the course of the build). Remaining open questions are at the bottom.

## Resolved

1. **Agent model** — RESOLVED: a multi-agent hub that fans out to per-site sub-agents. The "Multiple agents" toggle controls 1-vs-N; the hub is modular. (Paul confirmed.)
2. **Consumer view / next-steps tray** — RESOLVED: an inferred "next steps" tray (2-3 useful actions offered after a task, without taking over browsing). (Paul approved; built into the hub.)
3. **Tool approval** — RESOLVED: inferred (window.*) tools require first-run user approval per origin before the agent may call them. (Paul approved; built.)
4. **Memory persistence** — RESOLVED: origin-keyed OPFS (per-origin, one site can never read another). A sync/export (cloud backup) path is a FUTURE option, not in scope now.
5. **MHTML vs screenshots** — RESOLVED: both. Screenshots for the chat strip; MHTML for full-page archives, kept until the user deletes. (Paul decided.)
6. **WASM tool integration** — RESOLVED (direction): start with the WebMCP (window.*) tool inference + approval flow. A minimal WASM tool set with an owner upload mechanism is a FUTURE option (the wasm-vs-js work informs it).
7. **co-do double-iframe generative UI** — RESOLVED (built): generated HTML artifacts render inside the sandboxed double iframe with the artifact gallery/viewer plus CSP, network, and navigation guards.
8. **Hub sidebar Tasks/Agents layout** — RESOLVED (Paul, 2026-08-18): both sections use the same panel/list/overflow/scrollbar treatment and aligned inline-end + actions; collapsed content must remain centered and unobstructed by scrollbars.
9. **Full Agent Directory presentation** — RESOLVED (Paul, 2026-08-19): a full Directory view hides/inerts covered sidebar controls; focus enters after reveal and returns safely on close; each function presents canonical description/schema metadata and its own accessible source/approval state in semantic responsive order.
10. **Durable retention versus owner memory quota** — RESOLVED (Paul, 2026-08-21): keep the 500-key/store and byte ceilings as safety boundaries, retain all Durable history without automatic eviction, and isolate execution authority from owner/model master memory so routine schedules cannot consume its key budget or flood errors.

## Open

11. **Extension name/packaging** — "Chrome Agent Platform" is a placeholder. Rename + package for distribution later (low priority; decide before any public release).
12. **The model for the hub** — Gemini Nano is weak for tool-calling; which provider should be the recommended default for the best experience?
