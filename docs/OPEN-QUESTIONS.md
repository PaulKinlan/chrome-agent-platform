# Open questions for Paul

Resolved answers are recorded here (Paul confirmed each over the course of the build). Remaining open questions are at the bottom. Security-suite serialization is completed implementation custody, not a product-policy question. The shadow lazy-protocol recompose likewise makes no new product-policy choice: provider cutover stays excluded until its separate loaded-MV3 nondisclosure and uncallability gate.

## Resolved

1. **Agent model** — RESOLVED: a multi-agent hub that fans out to per-site sub-agents. The "Multiple agents" toggle controls 1-vs-N; the hub is modular. (Paul confirmed.)
2. **Consumer view / next-steps tray** — RESOLVED: an inferred "next steps" tray (2-3 useful actions offered after a task, without taking over browsing). (Paul approved; built into the hub.)
3. **Tool approval** — RESOLVED: inferred (window.*) tools require first-run user approval per origin before the agent may call them. (Paul approved; built.)
4. **Memory persistence** — RESOLVED: origin-keyed OPFS (per-origin, one site can never read another). A sync/export (cloud backup) path is a FUTURE option, not in scope now.
5. **MHTML vs screenshots** — RESOLVED: both. Screenshots for the chat strip; MHTML for full-page archives, kept until the user deletes. (Paul decided.)
6. **Wasm tool integration direction** — RESOLVED and elevated to P0 (Paul, 2026-08-22): build the Co-do-style tool operating layer, beginning with the owner-decision-free metadata catalog and lexical shadow index, then loaded-MV3 runtime proof and bundled provenance-clean tools. Existing WebMCP/browser/management dispatch and owner grants remain authoritative. Owner-uploaded execution is a separate distribution lane and is not enabled by this decision.
7. **co-do double-iframe generative UI** — RESOLVED (built): generated HTML artifacts render inside the sandboxed double iframe with the artifact gallery/viewer plus CSP, network, and navigation guards.
8. **Hub sidebar Tasks/Agents layout** — RESOLVED (Paul, 2026-08-18): both sections use the same panel/list/overflow/scrollbar treatment and aligned inline-end + actions; collapsed content must remain centered and unobstructed by scrollbars.
9. **Full Agent Directory presentation** — RESOLVED (Paul, 2026-08-19): a full Directory view hides/inerts covered sidebar controls; focus enters after reveal and returns safely on close; each function presents canonical description/schema metadata and its own accessible source/approval state in semantic responsive order.
10. **Durable retention versus owner memory quota** — RESOLVED (Paul, 2026-08-21): remove the arbitrary key-count ceiling, keep byte ceilings, retain all Durable history without automatic eviction, and isolate execution authority from owner/model master memory so routine schedules cannot crowd owner data or flood errors. OPFS search/indexing improvements are deferred.

## Open

11. **Extension name/distribution** — "Chrome Agent Platform" is a placeholder; the final public name and channel remain undecided. Archive freshness is no longer part of this decision: production ZIPs already use an exact tracked-plus-generated inventory and atomic fresh replacement.
12. **The model for the hub** — Gemini Nano is weak for tool-calling; which provider should be the recommended default for the best experience?
13. **Owner-selected Wasm distribution policy** — may a Chrome Web Store build execute genuinely local owner-selected Wasm without violating remotely hosted code policy? Until written policy resolves this, Store mode is bundled-reviewed-executables only; owner-selected packages remain an unpacked/enterprise/developer lane.
14. **Co-do licence/provenance reconciliation** — Co-do's root is Apache-2.0 while package and generated manifest metadata declare MIT. Which source/licence/SBOM/reproducibility authority must each candidate binary satisfy? No Co-do binary may be copied before this is resolved.
15. **Semantic index engine** — deterministic exact/alias/lexical retrieval ships first. Embedding model, dimensions, quality thresholds, storage engine (SQLite versus IndexedDB), device tiers, and telemetry policy remain decisions under the existing `CAP-FB-20260820-SEMANTIC-TOOL-SEARCH-01`; the task must not be duplicated.
