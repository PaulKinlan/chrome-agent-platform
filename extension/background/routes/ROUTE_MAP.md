# Service Worker Route $\to$ Module Map

This document records the assignment of service-worker message routes to their owning modules under `extension/background/routes/`.

## Architectural Boundaries & Single Seams
1. **Central Message Listener (`chrome.runtime.onMessage`)**: Handles sender authentication, page route allowlist (`PAGE_ALLOWED_ROUTES`), principal classification (`owner-options`), sender-derived document ID, and unified error shaping.
2. **Central Dispatcher (`dispatchRoute`)**: Performs route handler lookup, `__`-prefix / `userActivation` body parameter scrubbing, and `__sender` injection.
3. **Route Modules (`extension/background/routes/*.js`)**: Export frozen route maps containing pure handler functions. Modules never duplicate the central dispatcher, listener, or allowlist seams.

## Route Map Inventory (Slice 1)

| Route Name | Owning Module | Description | Principal Required |
|---|---|---|---|
| `kv.get` | `extension/background/routes/kv.js` | Read keys from KV storage with secret redaction and attestation key protection | Extension |
| `kv.set` | `extension/background/routes/kv.js` | Write keys to KV storage; secret-controlled keys require Settings | Extension (`owner-options` for secrets) |
| `kv.remove` | `extension/background/routes/kv.js` | Remove keys from KV storage; secret-controlled keys require Settings | Extension (`owner-options` for secrets) |
| `perm-lease.acquire` | `extension/background/routes/perm-lease.js` | Acquire permission prompt lease for origin pattern | Extension |
| `perm-lease.settle` | `extension/background/routes/perm-lease.js` | Settle permission prompt lease with token & broadcast | Extension |
| `perm-lease.state` | `extension/background/routes/perm-lease.js` | Query permission lease state | Extension |
| `provider.get` | `extension/background/routes/provider.js` | Read active provider configuration with redacted API key | `owner-options` |
| `provider.summary` | `extension/background/routes/provider.js` | Redacted provider summary for non-Settings UI surfaces | Extension |
| `provider.permission-summary` | `extension/background/routes/provider.js` | Permission origin pattern summary for provider preflight | Extension |
| `provider.status` | `extension/background/routes/provider.js` | Provider readiness check | Extension |
| `provider.set` | `extension/background/routes/provider.js` | Set provider config with SW-side key preservation | `owner-options` |
| `provider.clear-key` | `extension/background/routes/provider.js` | Clear stored provider API key | `owner-options` |
| `provider.test` | `extension/background/routes/provider.js` | Test provider connection with stored/provided key | `owner-options` |
| `provider.models` | `extension/background/routes/provider.js` | List available provider model presets | Extension |
| `activity.list` | `extension/background/routes/activity.js` | Fault-isolated, bounded aggregation of the master + named + background + site journals into the searchable activity timeline | Extension |
| `memory.get` | `extension/background/routes/memory.js` | Read a key from the resolved memory store; internal namespaces reserved | Extension |
| `memory.set` | `extension/background/routes/memory.js` | Write a key; legacy/orphan agent selectors are read-only; writes tracked for teardown quiescence | Extension |
| `memory.list` | `extension/background/routes/memory.js` | List keys on the resolved store; internal namespaces filtered | Extension |
| `memory.clear` | `extension/background/routes/memory.js` | Clear the resolved store; legacy agent selectors read-only; clears tracked for teardown quiescence | Extension |
| `tool-catalog.shadow` | `extension/background/service-worker.js` | Settings-only metadata/search/selection diagnostics; never execution or grants | `owner-options` |
| `fs-grant.list` / `fs-grant.get` / `fs-grant.remove` / `fs-grant.list-entries` / `fs-grant.search` / `fs-grant.read-file` / `fs-grant.scan` / `fs-grant.grep` | `extension/background/routes/fs-grants.js` | Persistent local-folder grants (summaries, listing, bounded read/search/grep). The model's read-only file tools call the fs-grants library directly and never need these routes | Extension / `owner-options` |
| `fs-grant.write-file` | `extension/background/routes/fs-grants.js` | The RAW write for the owner surfaces (Settings). The model principal is refused | Extension / `owner-options` |
| `fs-grant.write-file-approved` | `extension/background/routes/fs-grants.js` | The model's ONLY write path (`write_file`): fails closed on grant/mode/path/size/binary before staging, stages the on-disk-vs-proposed diff for the owner card, digest-binds the exact content, re-verifies the disk after Approve, then writes | `model` (run-bound approval dispatcher) |
| `agent-workspace.usage` / `agent-workspace.clear` | `extension/background/routes/agent-workspace.js` | The owner surface's window into an agent's PRIVATE OPFS workspace (CAP-FB-20260831-AGENT-PRIVATE-FS-01): usage by agent id (Settings edit dialog) and the owner-gesture Clear. The id→key mapping reuses slugifyAgentId via the workspace lib; the model principal is refused (its tools resolve the workspace from the run stamp directly) | Extension / `owner-options` |
| *All other routes (114)* | `extension/background/service-worker.js` (inline) | To be modularized in subsequent slices | Context-dependent |
