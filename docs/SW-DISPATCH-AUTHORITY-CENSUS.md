# Service Worker Dispatch Authority Census

**Status:** Authoritative Census (chrome-agent-platform-ygvt / CAP-FB-20260908-OWNER-DISPATCH-CENSUS-01)  
**Seams:** `extension/background/service-worker.js`, `extension/background/routes/`, `extension/lib/owner-approval.js`, `extension/lib/pure.js`  
**Population:** 288 total registered routes, derived by evaluating the executable composition (`mergeRouteMaps`) at `origin/main@f507d58f`.

---

## 1. Executive Summary & Purpose

This document provides a total, honest census of all 288 message routes registered in the Chrome Agent Platform Service Worker.

The population is the key set `mergeRouteMaps` in `service-worker.js` actually returns, evaluated at `origin/main@f507d58f` — not a hand-kept list. That evaluation corrected 276 → 285 (chrome-agent-platform-s7wl): the earlier count silently skipped the three maps `vaultRoutes`, `enclaveProxyRoutes` and `enclaveStatusRoutes` (9 routes, landed 2026-10-03 in `bd17634f`). The 260 this document's sibling threat model quoted and the 276 here were both wrong about the composed population; 285 is what composition produces.

Prior audits (such as 18ug) focused narrowly on call sites of `requireOwnerApproval`, identifying 31 approval sites. However, `requireOwnerApproval` is only one of multiple gating layers in the extension. A route that does not call `requireOwnerApproval` is not necessarily insecure, but a mutation that reaches state modification without an explicit policy decision represents an unclassified authority boundary.

The goals of this census are:
1. **Derive the complete registered-route population** directly from executable composition (`mergeRouteMaps` in `service-worker.js` and all constituent route modules).
2. **Classify every registered route** by operation type, permitted callers, authority gate, and owner policy.
3. **Audit owner-facing mutations**, distinguishing owner-direct actions from approval-required actions.
4. **Identify and inventory unclassified mutations**—operations that mutate persistent state without an explicit policy decision or principal check (e.g. `named-agent.set-tools` at `service-worker.js` ~7101).

---

## 2. Architectural Gating Layers

Every message arriving at the Service Worker passes through a layered defense-in-depth model:

```
[ Inbound Message ]
       │
       ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Central Message Listener (chrome.runtime.onMessage)           │
│ - authenticate sender via authorizeToolReport (lib/pure.js)            │
│ - if content-script: reject if type NOT in PAGE_ALLOWED_ROUTES (7)     │
│ - if options document: tag principal = "owner-options"                 │
│ - if other extension document: tag principal = "extension"             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 2: Central Dispatcher (dispatchRoute)                            │
│ - look up type in handlers map (288 registered routes)                 │
│ - scrub __* fields and userActivation from message body                │
│ - inject trusted browser-attested sender (__sender = pageSender)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 3: Route-Level Principal Fences                                  │
│ - requireSettingsSender(context): restricted to "owner-options"        │
│ - isOwnerPrincipal(context): restricted to "owner-options"|"extension" │
│ - wasmStreamOwner(context): document-bound OPFS stream authority       │
│ - model-only routes: requires principal === "model" & live executionId │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 4: Owner Approval Subsystem (requireOwnerApproval)               │
│ - if action in OWNER_DIRECT_ACTIONS and caller is extension UI:        │
│   auto-approve (owner click in UI document IS the authority)           │
│ - if action in APPROVAL_REQUIRED_ACTIONS or caller is model:           │
│   createPendingApproval -> render in-conversation card with digest     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 5: Domain & Storage Fences                                       │
│ - immutable instance IDs, origin isolation in OPFS, attestation keys   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. High-Level Population Summary (288 Routes)

| Category | Count | Permitted Callers | Gating Mechanism |
|---|---|---|---|
| **Page-Allowed (`PAGE_ALLOWED`)** | 7 | Web pages (content scripts) | `PAGE_ALLOWED_ROUTES` allowlist in `lib/pure.js` |
| **Settings-Only Direct (`SETTINGS_ONLY_DIRECT`)** | 51 | `owner-options` | `requireSettingsSender` or `wasmStreamOwner` |
| **Owner-Approval Direct (`OWNER_APPROVAL_DIRECT`)** | 13 | `owner-options`, `extension` | `requireOwnerApproval` + `isOwnerDirectApproval` |
| **Owner-Approval Required (`OWNER_APPROVAL_REQUIRED`)** | 17 | `model`, `extension` | `requireOwnerApproval` (always prompts or model card) |
| **Owner Extension-Fenced (`OWNER_EXTENSION_FENCED`)** | 25 | `owner-options`, `extension` | `isOwnerPrincipal(context)` |
| **Execution & Worker Orchestration** | 23 | `extension`, `model`, worker | `runControl`, `activeExecutions`, worker RPC |
| **Agent Task Board (`AGENT_BOARD`)** | 13 | `extension`, `model` | Board state machine, role fences |
| **Storage, KV & Memory Fenced** | 10 | `owner-options`, `extension` | Secret key fences, quiescence tracking, leases |
| **Unclassified Mutations (Gaps)** | 37 | `extension` (any) | Central page filter only; no route-local gate |
| **Read-Only / Status / Telemetry** | 92 | `owner-options`, `extension` | Read-only; no state mutation |
| **Total** | **288** | | |

---

## 4. Total Route Inventory & Classification

### 4.1 Page-Allowed Routes (`PAGE_ALLOWED_ROUTES` — 7 routes)
These are the ONLY routes accessible to content scripts. All other 281 routes reject content-script callers with `"not authorized from a page"`.

| Route Name | Owning Module | Description | Authority Gate |
|---|---|---|---|
| `webmcp.detect.bootstrap` | `service-worker.js` | Delivers extension-private key for passive detection | Browser-attested sender origin |
| `webmcp.detect.arm` | `service-worker.js` | Arms the main-world relay document | Browser-attested sender origin |
| `webmcp.detected` | `service-worker.js` | Reports page-detected WebMCP capabilities | Browser-attested sender origin |
| `tools.list` | `service-worker.js` | Lists enrolled tools for sender origin | Origin-keyed store |
| `tools.upsert` | `service-worker.js` | Reports tools discovered on sender origin | Origin-keyed store |
| `tools.pending` | `service-worker.js` | Checks pending tools for sender origin | Origin-keyed store |
| `enrollment.status` | `service-worker.js` | Syncs enrollment generation for origin | Origin-keyed store |

---

### 4.2 Settings-Only Direct Routes (`SETTINGS_ONLY_DIRECT` — 51 routes)
Restricted strictly to the Settings surface (`principal === "owner-options"`). General extension documents (hub, side panel), pages, and model calls are denied.

| Route Name | Owning Module | Description | Policy Gate |
|---|---|---|---|
| `provider.get` | `routes/provider.js` | Reads active provider configuration | `requireSettingsSender` |
| `provider.set` | `routes/provider.js` | Sets provider config & API keys | `requireSettingsSender` |
| `provider.clear-key` | `routes/provider.js` | Clears stored provider API key | `requireSettingsSender` |
| `provider.test` | `routes/provider.js` | Tests provider connection | `requireSettingsSender` |
| `mcp.servers.set` | `routes/mcp.js` | Sets global MCP server configurations | `requireSettingsSender` |
| `mcp.servers.test` | `routes/mcp.js` | Tests connection to remote MCP server | `requireSettingsSender` |
| `fs-grant.remove` | `routes/fs-grants.js` | Revokes a local folder grant | `requireSettingsSender` |
| `fs-grant.write-file` | `routes/fs-grants.js` | Unapproved direct write for Settings | `requireSettingsSender` |
| `system.factoryReset` | `service-worker.js` | Factory reset: deletes all extension data | `principal === "owner-options"` |
| `system.factoryResetEnumerate`| `service-worker.js`| Enumerates storage items for reset | `principal === "owner-options"` |
| `owner.export.all` | `service-worker.js` | Exports complete database & memories | `principal === "owner-options"` |
| `owner.import.all` | `service-worker.js` | Restores database from backup | `principal === "owner-options"` |
| `memory.purgeJournals` | `service-worker.js` | Purges journal history | `principal === "owner-options"` |
| `memory.sweepOrphans` | `service-worker.js` | Sweeps orphaned memory stores | `principal === "owner-options"` |
| `tool.preview.run` | `service-worker.js` | Diagnostic execution preview | `principal === "owner-options"` |
| `tool.package.validation-list`| `service-worker.js`| Lists schema-2 packages available for validation | `principal === "owner-options"` |
| `tool.package.validate` | `service-worker.js` | Validates a schema-2 package and records validation | `principal === "owner-options"` |
| `tool.package.run` | `service-worker.js` | Executes an admitted schema-2 package operation | `principal === "owner-options"` |
| `tool-catalog.shadow` | `service-worker.js` | Diagnostic shadow catalog query | `principal === "owner-options"` |
| `management.pending-approvals`| `service-worker.js`| Lists pending approval cards | `principal === "owner-options"` |
| `hooks.deny` | `service-worker.js` | Denies a hook subscription | `principal === "owner-options"` |
| `tools.policy.set` | `service-worker.js` | Sets site tool policy (allow/ask/block) | `requireSettingsSender` |
| `webmcp.consent.snapshot` | `service-worker.js` | Queries consent state | `requireSettingsSender` |
| `webmcp.consent.tool.set` | `service-worker.js` | Sets per-tool consent state | `requireSettingsSender` |
| `webmcp.consent.site.reset` | `service-worker.js` | Resets site consent state | `requireSettingsSender` |
| `webmcp.audit.list` | `service-worker.js` | Queries WebMCP audit trail | `requireSettingsSender` |
| `tools.approve` | `service-worker.js` | Approves pending tool enrollment | `requireSettingsSender` |
| `tool-stream.input.create` | `service-worker.js` | Creates OPFS input stream | `wasmStreamOwner` |
| `tool-stream.input.append` | `service-worker.js` | Appends bytes to OPFS stream | `wasmStreamOwner` |
| `tool-stream.input.seal` | `service-worker.js` | Finalizes OPFS input stream | `wasmStreamOwner` |
| `tool-stream.run` | `service-worker.js` | Executes Wasm tool over OPFS stream | `wasmStreamOwner` |
| `tool-stream.output.read` | `service-worker.js` | Reads window of output stream | `wasmStreamOwner` |
| `tool-stream.output.receipt` | `service-worker.js` | Retrieves execution receipt | `wasmStreamOwner` |
| `tool-stream.stage-attachment`| `service-worker.js`| Stages stream to task attachment | `wasmStreamOwner` |
| `tool-stream.stage-asset` | `service-worker.js` | Stages stream to artifact asset | `wasmStreamOwner` |
| `tool-stream.promote-output` | `service-worker.js`| Promotes tool stream to result | `wasmStreamOwner` |
| `tool-stream.remove` | `service-worker.js` | Removes stream reference | `wasmStreamOwner` |
| `tool-stream.discard` | `service-worker.js` | Discards active stream | `wasmStreamOwner` |
| `tool-stream.tabular-transform`| `service-worker.js`| Runs tabular transform on stream | `wasmStreamOwner` |
| `python.network.grant` | `service-worker.js` | Grants network access to origin for Python | `principal === "owner-options"` |
| `python.network.revoke` | `service-worker.js` | Revokes network access to origin for Python | `principal === "owner-options"` |
| `wheel.put` | `service-worker.js` | Ingests pure-Python wheel into OPFS store | `principal === "owner-options"` |
| `wheel.delete` | `service-worker.js` | Removes pure-Python wheel from OPFS store | `principal === "owner-options"` |
| `vault.status` | `routes/vault.js` | Reads the MASKED credential list, proxy rules and egress ledger | `requireSettingsSender` |
| `vault.set` | `routes/vault.js` | Stores a service credential (and its proxy rule) in the vault | `requireSettingsSender` |
| `vault.configureProxy` | `routes/vault.js` | Sets the proxied-service rule for a vault key | `requireSettingsSender` |
| `vault.rotate` | `routes/vault.js` | Rotates a stored credential's value | `requireSettingsSender` |
| `vault.delete` | `routes/vault.js` | Deletes a credential and its proxy rule | `requireSettingsSender` |
| `vault.ledger.clear` | `routes/vault.js` | Clears the enclave egress ledger | `requireSettingsSender` |
| `vault.test` | `routes/vault.js` | Runs ONE minimal proxied request; returns `{ ok, status, code }` only | `requireSettingsSender` |
| `enclave.status` | `service-worker.js` | Reports enclave enablement + configured services for Settings | `principal === "owner-options"` |

---

### 4.3 Owner-Approval Direct Routes (`OWNER_APPROVAL_DIRECT` — 13 routes)
These actions are declared in `OWNER_DIRECT_ACTIONS` in `extension/lib/owner-approval.js`.
When called by an owner UI document with a valid `documentId`, `isOwnerDirectApproval` returns `true`—the owner's click in the UI is the approval. When called by a model, they require an approval card.

| Route Name | Owning Module | Description | Approval Action |
|---|---|---|---|
| `named-agent.update` | `service-worker.js` | Updates agent name/role/model/settings | `named-agent.update` |
| `named-agent.delete` | `service-worker.js` | Deletes a named agent | `named-agent.delete` |
| `named-agent.set-schedule` | `routes/agent-schedule.js` | Sets recurring schedule for named agent | `named-agent.set-schedule` |
| `named-agent.set-mcp-servers`| `service-worker.js` | Sets agent-specific MCP servers | `named-agent.set-mcp-servers` |
| `agent.delete` | `service-worker.js` | Deletes a site agent and its origin memory | `agent.delete` |
| `asset.delete` | `service-worker.js` | Deletes an artifact from storage | `asset.delete` |
| `asset.restore` | `service-worker.js` | Restores an earlier version of an artifact | `asset.restore` |
| `script.create` | `service-worker.js` | Saves a user-created script | `script.create` |
| `script.run` | `service-worker.js` | Executes a user-created script in sandbox | `script.run` |
| `task.pause` | `routes/scheduler.js` | Pauses a scheduled routine | `task.pause` |
| `task.resume` | `routes/scheduler.js` | Resumes a paused scheduled routine | `task.resume` |
| `task.update` | `routes/scheduler.js` | Updates routine schedule configuration | `task.update` |
| `background-agent.delete` | `service-worker.js` (~10632) | Deletes a custom skill | **Strictly owner-only.** The route calls `requireOwnerApproval(context, "background-agent.delete", canonicalOperationTarget("background", {id}), payloadFields([["id", id]]))` since chrome-agent-platform-4h47 (it took no `context` at all before, so it could not call the seam). The action is in `OWNER_DIRECT_ACTIONS` and deliberately NOT in `DESTRUCTIVE_ACTIONS`, so a non-owner caller FAILS CLOSED as not approvable (no card) — the same disposition `named-agent.set-mcp-servers` carries (CAP-FB-20260908-MCP-APPROVAL-CONTRACT-01), not the model-card flow the other rows in this section have. Born as `recipe.delete`, renamed by l0r. |

---

### 4.4 Owner-Approval Required Routes (`OWNER_APPROVAL_REQUIRED` — 17 routes)
Actions that require an explicit owner approval card with a payload digest before execution when called by an agent or model.

| Route Name | Owning Module | Description | Action Identifier |
|---|---|---|---|
| `capability.revoke` | `service-worker.js` | Revokes an optional browser capability | `capability.revoke` |
| `named-agent.create` | `service-worker.js` | Creates a new named agent | `named-agent.create` — classed here because a MODEL caller pays the digest-bound card (pinned by `tests/named-agent-create-approval.test.ts`); an OWNER-principal create is direct (`owner-approval.js` `OWNER_DIRECT_ACTIONS`) and the route carries an owner fence, because `isOwnerDirectApproval` requires a browser-attested `documentId` while `requireOwnerApproval`'s early `!executionId` validation runs first — which refused the extension's own DOCUMENTLESS senders with the message an unapprovable non-owner call gets (chrome-agent-platform-4h47) |
| `named-agent.set-provider` | `service-worker.js` | Sets per-agent provider override | `named-agent.set-provider` |
| `agent.update` | `service-worker.js` | Updates site-agent configuration | `agent.update` |
| `asset.update` | `service-worker.js` | Overwrites an artifact | `asset.update` |
| `asset.patch` | `service-worker.js` | Applies a search/replace diff to artifact | `asset.update` (patch) |
| `asset.append` | `service-worker.js` | Appends content to an artifact | `asset.update` (append) |
| `script.update` | `service-worker.js` | Updates an existing script's content | `script.update` |
| `script.delete` | `service-worker.js` | Deletes a script | `script.delete` |
| `browser.cookie-value` | `service-worker.js` | Reads plaintext cookie value | `browser.cookie-value` |
| `browser.destructive-action`| `service-worker.js` | Closes tabs/windows, wipes data, cookies | Forwarded destructive action |
| `task.schedule-script` | `service-worker.js` | Schedules routine with scriptId | `task.schedule-script` |
| `workflow.run` | `service-worker.js` | Runs saved workflow script in sandbox | `workflow.run` |
| `hooks.subscribe` | `service-worker.js` | Subscribes to browser event hook; the card runs on EVERY subscribe, a first-time create included | `hooks.subscribe` |
| `hooks.unsubscribe` | `service-worker.js` | Unsubscribes from browser hook | `hooks.unsubscribe` |
| `fs-grant.write-file-approved` | `routes/fs-grants.js` | Model file write; verifies staged diff | `fs.write` |
| `webmcp.use-tool` | `service-worker.js` | Invokes tool on "ask"-policy site | `webmcp.use-tool` |

**Enforcement note — `hooks.subscribe` create path (chrome-agent-platform-51cd).** This route was classified here from the start and its handler did call `requireOwnerApproval`, but the seam in `subscribeHook` (`extension/lib/hooks.js`) ran only when a row for the exact `(hookId, skillId)` pair already existed (`if (existing && typeof gateOnReplace === "function")`). A FIRST-TIME pair therefore took the create path — `list.push(entry)` + `writeSubscriptions(list)` — with only the deny-list (and optional-permission) check in `checkHookAllowed`, so the one gate this census, `DESTRUCTIVE_ACTIONS` in `extension/lib/owner-approval.js` and the route's own call all declare was never reached on the common case. That was a declaration not enforced, not a policy choice: the sibling replace and `hooks.unsubscribe` paths both gated. chrome-agent-platform-51cd makes the seam unconditional and content-bound — it runs for EVERY subscribe and receives `{ existing: null }` on a create, whose digest form is the explicit `existing: {present: false}` marker so an approved retry still matches — and the persisted `promptTemplate` is no longer model-authorable (removed from the model-callable `subscribe_hook` schema, forced empty for a model principal) and is bounded at 64 KiB (`MAX_PROMPT_TEMPLATE_CHARS`). The classification, the route name and every count in this census are unchanged.

---

### 4.5 Owner Extension-Fenced Routes (`OWNER_EXTENSION_FENCED` — 25 routes)
Fenced with `isOwnerPrincipal(context)` (`"extension"` or `"owner-options"`). Callable by extension surfaces (hub, side panel, options), but rejected for pages.

| Route Name | Owning Module | Description |
|---|---|---|
| `acp.commands` | `service-worker.js` | Extension-only, temporary no-prompt/no-tool discovery session; always closes; no command dispatch |
| `browser.callTool` | `service-worker.js` | Invokes a browser tool (ACP in-app protocol) |
| `actions.undo` | `service-worker.js` | Undoes a user action recorded in ledger |
| `notifications.list` | `service-worker.js` | Lists pending extension notifications |
| `notification.get` | `service-worker.js` | Reads a single notification |
| `notification.dismiss` | `service-worker.js` | Dismisses a notification |
| `privacy.statement` | `service-worker.js` | Generates transparency statement |
| `tools.invoke` | `service-worker.js` | Extension UI invokes an enrolled tool directly |
| `management.resolve-approval` | `service-worker.js` | Settings resolves a pending approval card |
| `run.resolve-inline-approval` | `service-worker.js` | Chat resolves an inline approval card |
| `approval.detail` | `service-worker.js` | Reads approval card detail with diff |
| `run.dismissFailed` | `service-worker.js` | Dismisses a failed run notification |
| `run.cancel` | `service-worker.js` | Cancels an active run |
| `run.resume` | `service-worker.js` | Resumes an interrupted run |
| `run.continue` | `service-worker.js` | Continues an execution past token/step budget |
| `run.control.steer` | `service-worker.js` | Injects guidance message into live run |
| `run.control.queue.list` | `service-worker.js` | Lists queued follow-ups for a thread |
| `run.control.queue.enqueue` | `service-worker.js` | Enqueues a follow-up turn |
| `run.control.queue.remove` | `service-worker.js` | Removes an item from follow-up queue |
| `run.control.queue.move` | `service-worker.js` | Re-orders queue items |
| `run.retry` | `service-worker.js` | Retries a failed run |
| `run.logs` | `service-worker.js` | Retrieves logs for an execution |
| `site-skills.set` | `service-worker.js` | Sets per-origin site note |
| `agent-workspace.clear` | `routes/agent-workspace.js`| Clears an agent's private OPFS workspace |
| `enclave.proxy` | `routes/enclave-proxy.js` | One proxied request to an approved service, with vault-injected auth; refused for pages and model runs |

---

### 4.6 Execution & Worker Orchestration Routes (23 routes)
Triggers or manages interactive runs, background worker processes, and sandboxed job execution.

| Route Name | Owning Module | Description |
|---|---|---|
| `agent.run` | `service-worker.js` | Starts an interactive task run |
| `named-agent.run` | `service-worker.js` | Starts a named agent run |
| `named-agent.delegate` | `service-worker.js` | Delegates from one agent to another |
| `agent.delegate` | `service-worker.js` | Dispatches a worker subagent |
| `background-agent.run` | `service-worker.js` | Dispatches background routine |
| `skill.run` | `service-worker.js` | Executes a skill *(born as `recipe.run`, renamed by l0r)* |
| `register-task` | `service-worker.js` | Registers an alarm schedule |
| `run-task` | `service-worker.js` | Runs scheduled alarm task |
| `task.retry` | `routes/scheduler.js` | Retries failed scheduled task |
| `python.execute` | `service-worker.js` | Sandboxed Python execution via Pyodide |
| `python.fetch` | `service-worker.js` | Proxies permissioned network request for Python worker |
| `table.run` | `service-worker.js` | Sandboxed spreadsheet tool execution (run-bound) |
| `agent-worker.alive` | `routes/agent-worker.js` | Heartbeat from offscreen worker |
| `agent-worker.progress` | `routes/agent-worker.js` | Worker stream progress event |
| `agent-worker.result` | `routes/agent-worker.js` | Worker completion result |
| `agent-worker.ensure` | `routes/agent-worker.js` | Ensures offscreen worker is alive |
| `agent-worker.run` | `routes/agent-worker.js` | Commands offscreen worker to start task |
| `agent-worker.dispatch` | `routes/agent-worker.js` | Worker internal message relay |
| `agent-worker.tool` | `routes/agent-worker.js` | Worker tool call bridge (executes via SW) |
| `agent-worker.close` | `routes/agent-worker.js` | Terminates an offscreen worker |
| `agent-worker.steer` | `routes/agent-worker.js` | Sends steering input to offscreen worker |
| `agent-worker.journal-append`| `routes/agent-worker.js` | Appends worker event to run journal |
| `acp.journal` | `service-worker.js` | Journals user turn and streamed tool/assistant results from external agent harnesses into thread store |

---

### 4.7 Agent Board Routes (`AGENT_BOARD` — 13 routes)
Mounted from `extension/lib/agent-board.js` at `boardRoutes.routes`. Implements multi-agent shared task coordination.

| Route Name | Owning Module | Description | Operation Type |
|---|---|---|---|
| `board.list` | `lib/agent-board.js` | Lists active/claimed jobs on board | Read-only |
| `board.messages` | `lib/agent-board.js` | Lists messages posted to board | Read-only |
| `board.read` | `lib/agent-board.js` | Reads specific board job | Read-only |
| `board.deny.list` | `lib/agent-board.js` | Lists denied board operations | Read-only |
| `board.post` | `lib/agent-board.js` | Posts a new job to the board | Mutation |
| `board.claim` | `lib/agent-board.js` | Agent claims a pending job | Mutation |
| `board.complete` | `lib/agent-board.js` | Marks claimed job as completed | Mutation |
| `board.fail` | `lib/agent-board.js` | Marks job as failed | Mutation |
| `board.heartbeat` | `lib/agent-board.js` | Agent renews job claim lease | Mutation |
| `board.wake` | `lib/agent-board.js` | Wakes listening agent for job | Mutation |
| `board.message` | `lib/agent-board.js` | Posts communication to board | Mutation |
| `board.deny.add` | `lib/agent-board.js` | Adds denial to board policy | Mutation |
| `board.deny.remove` | `lib/agent-board.js` | Removes denial from board policy | Mutation |

---

### 4.8 Storage, KV & Memory Fenced Routes (10 routes)

| Route Name | Owning Module | Description | Gating Mechanism |
|---|---|---|---|
| `kv.get` | `routes/kv.js` | Reads KV key | Redacts secret namespaces |
| `kv.set` | `routes/kv.js` | Writes KV key | Secret keys require `owner-options` |
| `kv.remove` | `routes/kv.js` | Deletes KV key | Secret keys require `owner-options` |
| `perm-lease.state` | `routes/perm-lease.js` | Queries permission prompt lease | Read-only |
| `perm-lease.acquire` | `routes/perm-lease.js` | Acquires permission lease | Cryptographic generation bound |
| `perm-lease.settle` | `routes/perm-lease.js` | Settles permission lease | Generation-verified |
| `memory.get` | `routes/memory.js` | Reads key from memory store | Internal namespaces reserved |
| `memory.set` | `routes/memory.js` | Writes key to memory store | Reserved keys blocked, write tracked |
| `memory.list` | `routes/memory.js` | Lists keys in memory store | Internal namespaces filtered |
| `memory.clear` | `routes/memory.js` | Clears memory store | Quiescence tracked |

---

### 4.9 Unclassified Mutations (Gaps Inventory — 37 routes)
These routes perform state mutations (modifying storage, memory, agents, threads, or settings) but **lack an explicit policy gate** (`requireOwnerApproval`, `requireSettingsSender`, or `isOwnerPrincipal`). They rely solely on Layer 1 rejecting content scripts.

| Route Name | Owning Module | What It Mutates | Current Authority Checked | Gap / Risk | Proposed Remediation |
|---|---|---|---|---|---|
| **`named-agent.set-tools`** | `service-worker.js` (~7101) | Named agent tool list | Valid `id` string only | **High:** Any extension sender can alter agent tools without owner approval | Require `isOwnerPrincipal(context)` or `requireOwnerApproval("named-agent.update")` |
| `named-agent.avatar` | `service-worker.js` (~7250) | Named agent avatar image | Valid `id` string only | Cost/state mutation via Gemini API | Require `isOwnerPrincipal(context)` |
| `named-agent.refine` | `service-worker.js` (~7270) | Invokes model prompt refiner | None | Token cost invocation | Require `isOwnerPrincipal(context)` |
| `thread.delete` | `service-worker.js` (~6480) | Deletes thread from store | Valid `m.id` | Destructive loss of conversation history | Require `isOwnerPrincipal(context)` |
| `thread.rename` | `service-worker.js` (~6490) | Renames thread in store | Valid `m.id` | Overwrites thread title | Require `isOwnerPrincipal(context)` |
| `thread.name` | `service-worker.js` (~6500) | Generates title via model | None | Token cost + thread rename | Require `isOwnerPrincipal(context)` |
| `asset.create` | `service-worker.js` (~8150) | Creates artifact in store | None | Bypasses approval card (unlike update) | Classify as direct owner creation |
| `skill.import` | `service-worker.js` (~9350) | Imports custom skill | URL validation only | Mutates master skill registry | Require `isOwnerPrincipal(context)` |
| `skill.delete` | `service-worker.js` (~9370) | Deletes custom skill | Valid id | Mutates master skill registry | Require `isOwnerPrincipal(context)` |
| `skill.importBatch` | `service-worker.js` (~9400) | Batch imports skills | JSON array parse | Mutates master skill registry | Require `isOwnerPrincipal(context)` |
| `command.delete` | `service-worker.js` (~7690) | Deletes imported command | Valid id | Mutates imported commands list | Require `isOwnerPrincipal(context)` |
| `background-agent.duplicate` | `service-worker.js` (~9470) | Duplicates skill to custom | None | Writes new custom skill | Require `isOwnerPrincipal(context)` |
| `background-agent.update` | `service-worker.js` (~9490) | Updates custom skill | None | Overwrites custom skill | Require `isOwnerPrincipal(context)` |
| `background-agent.set` | `service-worker.js` (~9480) | Enables/disables bg agent | None | Creates/cancels recurring alarms | Require `isOwnerPrincipal(context)` |
| `prompt.set` | `service-worker.js` (~9600) | Overwrites system prompt | None | Overwrites global/agent prompts | Require `requireSettingsSender(context)` |
| `prompt.reset` | `service-worker.js` (~9620) | Resets system prompt | None | Resets prompts to default | Require `requireSettingsSender(context)` |
| `prompt.keep` | `service-worker.js` (~9640) | Retains custom prompt | None | Re-stamps customized prompts | Require `requireSettingsSender(context)` |
| `prompt.rotateAttestationKey`| `service-worker.js` (~9660) | Rotates HMAC attestation key | None | Invalidates prior prompt attestations | Require `requireSettingsSender(context)` |
| `browser-control.set` | `service-worker.js` (~9800) | Grants browser control | None | High-privilege permission state | Require `requireSettingsSender(context)` |
| `browser-control.revoke` | `service-worker.js` (~9780) | Revokes browser control | None | High-privilege permission state | Require `requireSettingsSender(context)` |
| `agent.create` | `service-worker.js` (~9850) | Enrolls origin site agent | None | Creates origin agent record | Require `isOwnerPrincipal(context)` |
| `agent.enroll-origin` | `service-worker.js` (~9870) | Enrolls origin site agent | None | Creates origin agent record | Require `isOwnerPrincipal(context)` |
| `agent.retry-cleanup` | `service-worker.js` (~9910) | Retries origin cleanup | None | Cleans origin storage | Require `isOwnerPrincipal(context)` |
| `agent.pending-cleanup` | `service-worker.js` (~9930) | Cleans pending origins | None | Cleans origin storage | Require `isOwnerPrincipal(context)` |
| `task.cancel` | `service-worker.js` (~9250) | Cancels alarm routine | None | Teardown of active alarm | Require `isOwnerPrincipal(context)` |
| `task.cancelBackground` | `service-worker.js` (~9270) | Cancels bg routine | None | Teardown of active alarm | Require `isOwnerPrincipal(context)` |
| `schedule.cancelOrphans`| `service-worker.js` (~9230) | Cleans orphaned alarms | None | Cancels alarms | Require `isOwnerPrincipal(context)` |
| `diagnostics.clear` | `service-worker.js` (~10000)| Clears diagnostics buffer | None | Clears diagnostic telemetry | Require `isOwnerPrincipal(context)` |
| `security.clear` | `service-worker.js` (~10080)| Clears security event log | None | Clears security audit trail | Require `requireSettingsSender(context)` |
| `usage.clear` | `service-worker.js` (~8050) | Clears usage statistics | None | Clears billing/token tracking | Require `requireSettingsSender(context)` |
| `webmcp.diagnostics.set`| `service-worker.js` (~7880)| Sets diagnostic logging | None | Toggles verbose diagnostic state | Require `isOwnerPrincipal(context)` |
| `skills.set` | `service-worker.js` (~7940) | Sets origin skills | None | Overwrites site skills | Require `isOwnerPrincipal(context)` |
| `clipboard.write` | `service-worker.js` (~6703) | Writes text to the system clipboard | `clipboardWrite` permission + the offscreen document | Clipboard is a data-egress channel (any tab's paste target); relies on the permission only | Require `isOwnerPrincipal(context)` |
| `write_clipboard` | `service-worker.js` (~6733) | Alias of `clipboard.write` | Same as `clipboard.write` | Same as `clipboard.write` — an alias is a second unclassified entry point | Require `isOwnerPrincipal(context)` |
| `page.capture` | `service-worker.js` (~9513) | Captures a tab to an artifact | Valid `tabId` | Writes an artifact (and can attach a screenshot) with no policy decision | Require `isOwnerPrincipal(context)` |
| `capture.page` | `service-worker.js` (~9517) | Alias of `page.capture` | Valid `tabId` | Same as `page.capture`; the sibling spelling is a second entry point | Require `isOwnerPrincipal(context)` |
| `asset.export-to-folder` | `service-worker.js` (~9759) | Writes an artifact's bytes into an owner-granted local folder | Valid id + a granted folder | **Discrepancy:** its capability row (`export_asset_to_folder`) is labelled `destructive` (`DESTRUCTIVE_POLICY_TOOLS` in `lib/chrome-tool-capabilities.js`), but the route itself calls no owner-approval seam — a declared destructive class with no route-local gate | Wire `requireOwnerApproval(context, "asset.export-to-folder")` for the model path, or reclassify the row |

---

### 4.10 Read-Only / Status / Telemetry Routes (92 routes)
These routes perform no state mutations and return status, listings, configuration summaries, or diagnostics. `webmcp.diagnostics.get` is owner-extension-fenced; its global toggle is never returned to a page sender or passed into the page's MAIN-world bootstrap.

`actions.list`, `activity.list`, `agent-workspace.usage`, `agent.directory`, `agent.discoverable-tabs`, `agent.get`, `agent.history-view`, `agent.list`, `agent.listAll`, `agent.orchestrator`, `agent.registry`, `agent.tool-offers`, `alarms.permission-granted`, `asset.capacity`, `asset.get`, `asset.list`, `asset.version-get`, `asset.versions`, `background-agent.history`, `background-agent.list`, `browser-control.get`, `cap:fetch`, `capabilities.status`, `capability.request`, `capture.tab`, `command.list`, `diagnostics.list`, `diagnostics.report`, `fs-grant.get`, `fs-grant.grep`, `fs-grant.list`, `fs-grant.list-entries`, `fs-grant.read-file`, `fs-grant.scan`, `fs-grant.search`, `hooks.status`, `invalidate-agent`, `mcp.servers.get`, `mcp.servers.global-redacted`, `memory.origins`, `memory.overview`, `memory.stores`, `named-agent.get`, `named-agent.grep`, `named-agent.history`, `named-agent.list`, `named-agent.delegations`, `observability.clearTrace`, `observability.dumpTrace`, `observability.page-measures`, `observability.setVerbosity`, `onDeviceText.summarize`, `onDeviceText.detectLanguage`, `onDeviceText.translate`, `onDeviceText.availability`, `prompt.attest`, `prompt.attestRun`, `prompt.describe`, `provider.models`, `provider.permission-summary`, `provider.status`, `provider.summary`, `background-agent.custom-list`, `run-log.list`, `run.dismissedFailed`, `run.list`, `schedules.list`, `screenshots.get`, `screenshots.list`, `script.get`, `script.list`, `security.state`, `sidepanel.getTarget`, `sidepanel.getTools`, `sidepanel.openPage`, `site-skills.get`, `skill.discover`, `skill.list`, `skills.all`, `skills.get`, `task.list`, `task.nextRun`, `thread.get`, `thread.list`, `tools.allOrigins`, `tools.consent.states`, `tools.policies`, `usage.get`, `webmcp.diagnostics.get`, `webmcp.status`, `python.network.grants`, `wheel.list`.

---

## 5. Specific Analysis of Named Findings

### 5.1 The `named-agent.set-tools` Anomaly (~7101)
- **Observed Behavior:** `named-agent.set-tools` directly invokes `setNamedAgentToolsConfig(id, tools)`.
- **Contrast with Peer Routes:**
  - `named-agent.update`: calls `requireOwnerApproval(context, "named-agent.update", ...)`
  - `named-agent.set-schedule`: calls `requireOwnerApproval(context, "named-agent.set-schedule", ...)`
  - `named-agent.set-provider`: calls `requireOwnerApproval(context, "named-agent.set-provider", ...)`
  - `named-agent.set-mcp-servers`: calls `requireOwnerApproval(context, "named-agent.set-mcp-servers", ...)`
  - `named-agent.delete`: calls `requireOwnerApproval(context, "named-agent.delete", ...)`
- **Mechanism:** It relies purely on the Layer 1 sender filter (`PAGE_ALLOWED_ROUTES` excluding content scripts). Inside the extension context, any sender with `principal: "extension"` can overwrite the agent's tool config without triggering `requireOwnerApproval` or requiring `owner-options`.
- **Remediation Recommendation:** Route should require `isOwnerPrincipal(context)` and invoke `requireOwnerApproval(context, "named-agent.update", slug, { tools })`.

### 5.2 The `background-agent.delete` Discrepancy (~10632, born as `recipe.delete`) — RESOLVED
- **Observed Behavior:** `background-agent.delete` is declared in `OWNER_DIRECT_ACTIONS` in `extension/lib/owner-approval.js`.
- **Actual Code (before chrome-agent-platform-4h47):** The route handler in `service-worker.js` did not call `requireOwnerApproval(context, "background-agent.delete")`; it did not even take a `context` parameter, so no seam could be called. Any extension document — and any non-owner caller — could delete a background agent outright.
- **Resolution (chrome-agent-platform-4h47):** The handler now takes `context` and calls `requireOwnerApproval` FIRST, ahead of the durable schedule teardown, with the canonical target `canonicalOperationTarget("background", { id })` and the payload `payloadFields([["id", id]])`. An owner-direct caller (an owner UI document with a browser-attested `documentId`) is unchanged. A NON-owner caller fails closed as "operation is not approvable": the action is deliberately NOT in `DESTRUCTIVE_ACTIONS`, so no pending card can be raised for it — the same strictly-owner-only disposition `named-agent.set-mcp-servers` carries (CAP-FB-20260908-MCP-APPROVAL-CONTRACT-01). The policy lists were NOT widened to make the census sentence true; the census was corrected instead, and §4.3's row now says so. Pinned by `tests/background-agent-delete-approval.test.ts`.
- **Disposition:** fixed in this bead, not declared as an exclusion — the graded classes therefore need no exclusions for this route.

### 5.3 The `named-agent.set-mcp-servers` Approver Policy (Resolved in gcuw)
- **Observed Behavior:** `named-agent.set-mcp-servers` is in `OWNER_DIRECT_ACTIONS`, but absent from `DESTRUCTIVE_ACTIONS`.
- **Consequence & Resolution (chrome-agent-platform-gcuw):** Owner direct calls succeed (`isOwnerDirectApproval` is true). If a model attempts to propose an MCP server change, `createPendingApproval` intentionally fails closed with `"operation is not approvable"` because the operation is strictly owner-only and model callers must not trigger an approval flow to write server endpoints or credentials. The comment and contract were reconciled in `gcuw` (0.3.358) and pinned by `tests/mcp-approval-contract.test.ts`.

### 5.4 Route-to-Seam Enforcement (chrome-agent-platform-gn3c)
`tests/sw-dispatch-authority-census.test.ts` parses the registered handler AST and checks each of the 13 §4.3 direct and 17 §4.4 required routes against its approval call. Extracted scheduler, agent-schedule, and file-grant handlers must retain their injected `requireOwnerApproval`; the script and site-tool helper calls must retain their forwarding seam. Direct actions must remain in `OWNER_DIRECT_ACTIONS` and reach `isOwnerDirectApproval`; required actions must remain approvable in `DESTRUCTIVE_ACTIONS`. AST mutants deleting the `capability.revoke` call, scheduler approval injection, or script helper's forwarding call each fail naming the affected route.

The reviewed action-name exceptions are explicit and still require a real call: `asset.patch` and `asset.append` use the `asset.update` card; `fs-grant.write-file-approved` uses `fs.write`; `browser.destructive-action` accepts only members of `DESTRUCTIVE_BROWSER_ACTIONS`, each of which must be approvable. `named-agent.delete` uses the injected `createNamedAgentDeleteGate` before teardown. This check proves static seam presence and the declared action, not full runtime control-flow dominance or authority coverage for the 37 unclassified §4.9 routes; those gaps remain separately tracked.

---

## 6. Non-Dispatcher Extension Message Listeners & Sender Predicates

In addition to the central Service Worker dispatcher (`chrome.runtime.onMessage.addListener` in `extension/background/service-worker.js`), several modules register `chrome.runtime.onMessage` listeners in offscreen document, page, or content script contexts.

Because `chrome.runtime.onMessage` is a broadcast message bus within the extension, any frame or content script sharing the extension ID can emit messages to this bus. If host listeners accept execution requests without checking `sender`, callers can bypass the Service Worker's Layer 1 (`PAGE_ALLOWED_ROUTES`), Layer 2 (`dispatchRoute`), and Layer 3 principal fences.

### 6.1 Defense-in-Depth Invariant: Sender Identity Predicates
Every non-dispatcher message listener in `extension/` MUST enforce a sender predicate or be explicitly allowlisted in `tests/onmessage-sender-guard.test.ts`.

1. **Service Worker Authority Fences (`isTrustedServiceWorkerSender`)**:
   Execution hosts (offscreen Worker executors, Python Pyodide runner, shared agent workers, on-device text models, sandboxed iframe script execution, and clipboard writes) must accept execution commands ONLY from the background Service Worker:
   - `sender.id === runtime.id`
   - `sender.tab == null` (reject content scripts)
   - `sender.documentId == null` (reject extension documents/frames)
   - `sender.url === runtime.getURL("dist/background/service-worker.js")` (pin to the compiled Service Worker bundle)

2. **Content Script Isolation Fences**:
   Content scripts receiving extension notifications (`content-script.js`, `webmcp-detect-relay.js`) must verify:
   - `sender != null` (reject missing sender)
   - `sender.id === runtime.id`
   - `sender.tab == null` (prevent cross-tab / cross-frame message injection)

### 6.2 Complete Non-Dispatcher Listener Inventory

| Location | Context | Message Types / Operations | Enforced Sender Predicate | Authority Level |
|---|---|---|---|---|
| `extension/lib/wasm-stream-host.js` | Offscreen Document | `cap:wasm-stream-run` | `isTrustedWasmStreamSender` | SW execution authority only |
| `extension/lib/wasm-callexport-host.js` | Offscreen Document | `cap:wasm-callexport-run` | `isTrustedWasmStreamSender` | SW execution authority only |
| `extension/lib/wasm-job-host.js` | Offscreen Document | `cap:wasm-wasi-job-run` | `isTrustedServiceWorkerSender` | SW execution authority only |
| `extension/lib/user-wasm-host.js` | Offscreen Document | `cap:user-wasm-run` | `isTrustedWasmStreamSender` | SW execution authority only |
| `extension/lib/svg-rasterise-host.js` | Offscreen Document | `cap:svg-rasterise-run` | `isTrustedWasmStreamSender` | SW execution authority only |
| `extension/lib/wasm-preview-host.js` | Options Page | `wasm.preview.options` | `isTrustedServiceWorkerSender` | SW execution authority only |
| `extension/lib/table-worker-host.js` | Offscreen Document | `table-worker:run`, `table-worker:cancel` | `isTrustedTableWorkerSender` | SW execution authority only |
| `extension/lib/python-host.js` | Offscreen Document | `python.run` | `isTrustedServiceWorkerSender` | SW execution authority only |
| `extension/lib/agent-worker-host.js` | Offscreen Document | `agent-worker-host:ensure`, `close`, `list`, `post` | `isTrustedServiceWorkerSender` | SW execution authority only |
| `extension/lib/on-device-text-host.js` | Offscreen Document | `onDeviceText.summarize`, `detectLanguage`, `translate`, `availability` | `isTrustedServiceWorkerSender` | SW execution authority only |
| `extension/offscreen/offscreen.js` | Offscreen Document | `cap:clipboard-write` | `isTrustedServiceWorkerSender` | SW execution authority only |
| `extension/lib/script-host.js` (`ntp.js`, `offscreen.js`) | NTP Page / Offscreen Document | `cap:script-run-announce`, `cap:script-run` | `isTrustedServiceWorkerSender` | SW execution authority only |
| `extension/lib/provider-gate.js` | Options / NTP Page | `provider-host-perm:settled` | `isTrustedServiceWorkerSender` | SW broadcast notification |
| `extension/content/content-script.js` | Web Page (Isolated World) | `invoke-tool`, `collect-tools`, `enrollment-sync`, `disenrollment`, `tool-consent-revoked`, `enrollment.poke`, `bridge.ping` | Extension ID + `tab == null` | Extension origin only |
| `extension/content/webmcp-detect-relay.js` | Web Page (Isolated World) | `webmcp.detect.rearm` | Extension ID + `tab == null` | Extension origin only |

