# Service Worker Route $\to$ Module Map

This document records the assignment of service-worker message routes to their owning modules under `extension/background/routes/`.

## Architectural Boundaries & Single Seams
1. **Central Message Listener (`chrome.runtime.onMessage`)**: Handles sender authentication, page route allowlist (`PAGE_ALLOWED_ROUTES`), principal classification (`owner-options`), sender-derived document ID, and unified error shaping.
2. **Central Dispatcher (`dispatchRoute`)**: Performs route handler lookup, `__`-prefix / `userActivation` body parameter scrubbing, and `__sender` injection.
3. **Route Modules (`extension/background/routes/*.js`)**: Export frozen route maps containing pure handler functions. Modules never duplicate the central dispatcher, listener, or allowlist seams.

## Route Map Inventory (Comprehensive Census — 258 Routes)

See `docs/SW-DISPATCH-AUTHORITY-CENSUS.md` for the exhaustive authority classification across all 258 routes.

| Module / Scope | Route Count | Routes Included | Gating / Authority Model |
|---|---|---|---|
| `routes/kv.js` | 3 | `kv.get`, `kv.set`, `kv.remove` | Extension principal; secret namespaces require `owner-options` |
| `routes/perm-lease.js` | 3 | `perm-lease.acquire`, `perm-lease.settle`, `perm-lease.state` | Extension principal; cryptographic generation bound |
| `routes/provider.js` | 8 | `provider.get`, `provider.summary`, `provider.permission-summary`, `provider.status`, `provider.set`, `provider.clear-key`, `provider.test`, `provider.models` | Settings-gated (`owner-options`) for keys/config/tests; extension for summaries |
| `routes/mcp.js` | 4 | `mcp.servers.get`, `mcp.servers.set`, `mcp.servers.test`, `mcp.servers.global-redacted` | Settings-gated (`owner-options`) for set/test; extension for get/redacted |
| `routes/activity.js` | 1 | `activity.list` | Extension principal |
| `routes/memory.js` | 4 | `memory.get`, `memory.set`, `memory.list`, `memory.clear` | Extension principal; reserved namespaces blocked; quiescence-tracked |
| `routes/fs-grants.js` | 10 | `fs-grant.list`, `fs-grant.get`, `fs-grant.remove`, `fs-grant.list-entries`, `fs-grant.search`, `fs-grant.read-file`, `fs-grant.write-file`, `fs-grant.scan`, `fs-grant.grep`, `fs-grant.write-file-approved` | Extension / `owner-options`; `write-file-approved` requires `model` principal + staged approval verification |
| `routes/agent-workspace.js` | 2 | `agent-workspace.usage`, `agent-workspace.clear` | Extension / `owner-options` |
| `routes/agent-schedule.js` | 1 | `named-agent.set-schedule` | Gated by `requireOwnerApproval("named-agent.set-schedule")` (`OWNER_DIRECT_ACTIONS`) |
| `routes/scheduler.js` | 5 | `schedules.list`, `task.pause`, `task.resume`, `task.update`, `task.retry` | Mutation routes gated by `requireOwnerApproval` (`OWNER_DIRECT_ACTIONS`) |
| `routes/agent-worker.js` | 10 | `agent-worker.ensure`, `agent-worker.run`, `agent-worker.dispatch`, `agent-worker.tool`, `agent-worker.alive`, `agent-worker.close`, `agent-worker.steer`, `agent-worker.progress`, `agent-worker.result`, `agent-worker.journal-append` | Offscreen agent worker RPC bridge; internal coordination |
| `extension/lib/agent-board.js` (`boardRoutes.routes`) | 13 | `board.post`, `board.wake`, `board.claim`, `board.complete`, `board.fail`, `board.heartbeat`, `board.list`, `board.messages`, `board.read`, `board.message`, `board.deny.add`, `board.deny.remove`, `board.deny.list` | Multi-agent task board state machine; model/extension principal |
| `service-worker.js` (inline arg[8]) | 17 | `table.run`, `tool-stream.*` (12 routes), `observability.page-measures`, `observability.setVerbosity`, `diagnostics.report`, `security.state` | `table.run` requires live agent run; `tool-stream.*` requires Settings document ID via `wasmStreamOwner` |
| `service-worker.js` (inline arg[13]) | 177 | Approval-gated mutations (agent/asset/script/browser/hooks/workflows), Settings-only routes, extension-only management, task execution, WebMCP, and query routes | See `docs/SW-DISPATCH-AUTHORITY-CENSUS.md` for per-route classification |
| **Total Registered Routes** | **258** | Complete population verified by `tests/sw-dispatch-authority-census.test.ts` | Complete census |
