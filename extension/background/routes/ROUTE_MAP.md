# Service Worker Route $\to$ Module Map

This document records the assignment of service-worker message routes to their owning modules under `extension/background/routes/`.

## Architectural Boundaries & Single Seams
1. **Central Message Listener (`chrome.runtime.onMessage`)**: Handles sender authentication, page route allowlist (`PAGE_ALLOWED_ROUTES`), principal classification (`owner-options`), sender-derived document ID, and unified error shaping.
2. **Central Dispatcher (`dispatchRoute`)**: Performs route handler lookup, `__`-prefix / `userActivation` body parameter scrubbing, and `__sender` injection.
3. **Route Modules (`extension/background/routes/*.js`)**: Export frozen route maps containing pure handler functions. Modules never duplicate the central dispatcher, listener, or allowlist seams.

## Route Map Inventory (Comprehensive Census — 287 Routes)

See `docs/SW-DISPATCH-AUTHORITY-CENSUS.md` for the exhaustive authority classification across all 287 routes. Argument indexes below are zero-based positions in `service-worker.js`'s `mergeRouteMaps`; `tests/sw-dispatch-authority-census.test.ts` checks them against the executable composition.

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
| `routes/vault.js` (`vaultRoutes`, arg[0]) | 7 | `vault.status`, `vault.set`, `vault.configureProxy`, `vault.rotate`, `vault.delete`, `vault.ledger.clear`, `vault.test` | Settings-only via `requireSettingsSender` |
| `routes/enclave-proxy.js` (`enclaveProxyRoutes`, arg[1]) | 1 | `enclave.proxy` | Owner extension fence or trusted SW internal caller |
| `service-worker.js` (`enclaveStatusRoutes`, arg[2]) | 1 | `enclave.status` | Settings-only |
| `service-worker.js` (inline arg[3]) | 7 | `browser.callTool`, `onDeviceText.summarize`, `onDeviceText.detectLanguage`, `onDeviceText.translate`, `onDeviceText.availability`, `clipboard.write`, `write_clipboard` | See census for per-route authority |
| `service-worker.js` (inline arg[12]) | 24 | `table.run`, `tool-stream.input.create`, `tool-stream.input.append`, `tool-stream.input.seal`, `tool-stream.run`, `tool-stream.output.read`, `tool-stream.output.receipt`, `tool-stream.remove`, `actions.list`, `actions.undo`, `cap:fetch`, `python.fetch`, `python.network.grants`, `python.network.grant`, `python.network.revoke`, `wheel.list`, `wheel.put`, `wheel.delete`, `capabilities.status`, `notifications.list`, `notification.get`, `notification.dismiss`, `alarms.permission-granted`, `capability.revoke` | Mixed authority; see census for each route |
| `service-worker.js` (inline arg[17]) | 183 | Approval-gated mutations (agent/asset/script/browser/hooks/workflows), Settings-only routes, extension-only management, task execution, WebMCP, and query routes | See `docs/SW-DISPATCH-AUTHORITY-CENSUS.md` for per-route classification |
| **Total Registered Routes** | **287** | Complete population verified by `tests/sw-dispatch-authority-census.test.ts` | Complete census |
