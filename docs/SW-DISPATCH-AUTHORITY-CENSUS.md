# Service Worker Dispatch Authority Census

**Status:** Authoritative Census (chrome-agent-platform-ygvt / CAP-FB-20260908-OWNER-DISPATCH-CENSUS-01)  
**Seams:** `extension/background/service-worker.js`, `extension/background/routes/`, `extension/lib/owner-approval.js`, `extension/lib/pure.js`  
**Population:** 258 total registered routes derived from executable composition (`mergeRouteMaps`).

---

## 1. Executive Summary & Purpose

This document provides a total, honest census of all 258 message routes registered in the Chrome Agent Platform Service Worker.

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
│ - if content-script: reject if type NOT in PAGE_ALLOWED_ROUTES (8)     │
│ - if options document: tag principal = "owner-options"                 │
│ - if other extension document: tag principal = "extension"             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 2: Central Dispatcher (dispatchRoute)                            │
│ - look up type in handlers map (258 registered routes)                 │
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

## 3. High-Level Population Summary (258 Routes)

| Category | Count | Permitted Callers | Gating Mechanism |
|---|---|---|---|
| **Page-Allowed (`PAGE_ALLOWED`)** | 8 | Web pages (content scripts) | `PAGE_ALLOWED_ROUTES` allowlist in `lib/pure.js` |
| **Settings-Only Direct (`SETTINGS_ONLY_DIRECT`)** | 36 | `owner-options` | `requireSettingsSender` or `wasmStreamOwner` |
| **Owner-Approval Direct (`OWNER_APPROVAL_DIRECT`)** | 13 | `owner-options`, `extension` | `requireOwnerApproval` + `isOwnerDirectApproval` |
| **Owner-Approval Required (`OWNER_APPROVAL_REQUIRED`)** | 16 | `model`, `extension` | `requireOwnerApproval` (always prompts or model card) |
| **Owner Extension-Fenced (`OWNER_EXTENSION_FENCED`)** | 22 | `owner-options`, `extension` | `isOwnerPrincipal(context)` |
| **Execution & Worker Orchestration** | 21 | `extension`, `model`, worker | `runControl`, `activeExecutions`, worker RPC |
| **Agent Task Board (`AGENT_BOARD`)** | 13 | `extension`, `model` | Board state machine, role fences |
| **Storage, KV & Memory Fenced** | 10 | `owner-options`, `extension` | Secret key fences, quiescence tracking, leases |
| **Unclassified Mutations (Gaps)** | 31 | `extension` (any) | Central page filter only; no route-local gate |
| **Read-Only / Status / Telemetry** | 88 | `owner-options`, `extension` | Read-only; no state mutation |
| **Total** | **258** | | |

---

## 4. Total Route Inventory & Classification

### 4.1 Page-Allowed Routes (`PAGE_ALLOWED_ROUTES` — 8 routes)
These are the ONLY routes accessible to content scripts. All other 250 routes reject content-script callers with `"not authorized from a page"`.

| Route Name | Owning Module | Description | Authority Gate |
|---|---|---|---|
| `webmcp.detect.bootstrap` | `service-worker.js` | Delivers extension-private key for passive detection | Browser-attested sender origin |
| `webmcp.detect.arm` | `service-worker.js` | Arms the main-world relay document | Browser-attested sender origin |
| `webmcp.detected` | `service-worker.js` | Reports page-detected WebMCP capabilities | Browser-attested sender origin |
| `tools.list` | `service-worker.js` | Lists enrolled tools for sender origin | Origin-keyed store |
| `tools.upsert` | `service-worker.js` | Reports tools discovered on sender origin | Origin-keyed store |
| `tools.pending` | `service-worker.js` | Checks pending tools for sender origin | Origin-keyed store |
| `webmcp.diagnostics.get` | `service-worker.js` | Reads diagnostics toggle for origin | Read-only |
| `enrollment.status` | `service-worker.js` | Syncs enrollment generation for origin | Origin-keyed store |

---

### 4.2 Settings-Only Direct Routes (`SETTINGS_ONLY_DIRECT` — 36 routes)
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
| `recipe.delete` | `service-worker.js` | Deletes a custom recipe | `recipe.delete` *(Declared in Set)* |

---

### 4.4 Owner-Approval Required Routes (`OWNER_APPROVAL_REQUIRED` — 16 routes)
Actions that require an explicit owner approval card with a payload digest before execution when called by an agent or model.

| Route Name | Owning Module | Description | Action Identifier |
|---|---|---|---|
| `capability.revoke` | `service-worker.js` | Revokes an optional browser capability | `capability.revoke` |
| `named-agent.create` | `service-worker.js` | Creates a new named agent | `named-agent.create` |
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
| `hooks.subscribe` | `service-worker.js` | Subscribes to browser event hook | `hooks.subscribe` |
| `hooks.unsubscribe` | `service-worker.js` | Unsubscribes from browser hook | `hooks.unsubscribe` |
| `fs-grant.write-file-approved` | `routes/fs-grants.js` | Model file write; verifies staged diff | `fs.write` |
| `webmcp.use-tool` | `service-worker.js` | Invokes tool on "ask"-policy site | `webmcp.use-tool` |

---

### 4.5 Owner Extension-Fenced Routes (`OWNER_EXTENSION_FENCED` — 22 routes)
Fenced with `isOwnerPrincipal(context)` (`"extension"` or `"owner-options"`). Callable by extension surfaces (hub, side panel, options), but rejected for pages.

| Route Name | Owning Module | Description |
|---|---|---|
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

---

### 4.6 Execution & Worker Orchestration Routes (21 routes)
Triggers or manages interactive runs, background worker processes, and sandboxed job execution.

| Route Name | Owning Module | Description |
|---|---|---|
| `agent.run` | `service-worker.js` | Starts an interactive task run |
| `named-agent.run` | `service-worker.js` | Starts a named agent run |
| `named-agent.delegate` | `service-worker.js` | Delegates from one agent to another |
| `agent.delegate` | `service-worker.js` | Dispatches a worker subagent |
| `background-agent.run` | `service-worker.js` | Dispatches background routine |
| `recipe.run` | `service-worker.js` | Executes a recipe |
| `register-task` | `service-worker.js` | Registers an alarm schedule |
| `run-task` | `service-worker.js` | Runs scheduled alarm task |
| `task.retry` | `routes/scheduler.js` | Retries failed scheduled task |
| `python.execute` | `service-worker.js` | Sandboxed Python execution via Pyodide |
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

### 4.9 Unclassified Mutations (Gaps Inventory — 31 routes)
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
| `recipe.duplicate` | `service-worker.js` (~9500) | Duplicates recipe to custom | None | Writes new custom recipe | Require `isOwnerPrincipal(context)` |
| `recipe.update` | `service-worker.js` (~9520) | Updates custom recipe | None | Overwrites custom recipe | Require `isOwnerPrincipal(context)` |
| `recipe.delete` | `service-worker.js` (~9534) | Deletes custom recipe | None | **Discrepancy:** In `OWNER_DIRECT_ACTIONS`, but never calls `requireOwnerApproval` | Wire `requireOwnerApproval(context, "recipe.delete")` |
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

---

### 4.10 Read-Only / Status / Telemetry Routes (88 routes)
These routes perform no state mutations and return status, listings, configuration summaries, or diagnostics.

`actions.list`, `activity.list`, `agent-workspace.usage`, `agent.directory`, `agent.discoverable-tabs`, `agent.get`, `agent.history-view`, `agent.list`, `agent.listAll`, `agent.orchestrator`, `agent.registry`, `agent.tool-offers`, `alarms.permission-granted`, `asset.capacity`, `asset.get`, `asset.list`, `asset.version-get`, `asset.versions`, `background-agent.history`, `background-agent.list`, `browser-control.get`, `cap:fetch`, `capabilities.status`, `capability.request`, `capture.tab`, `command.list`, `diagnostics.list`, `diagnostics.report`, `fs-grant.get`, `fs-grant.grep`, `fs-grant.list`, `fs-grant.list-entries`, `fs-grant.read-file`, `fs-grant.scan`, `fs-grant.search`, `hooks.status`, `invalidate-agent`, `mcp.servers.get`, `mcp.servers.global-redacted`, `memory.origins`, `memory.overview`, `memory.stores`, `named-agent.get`, `named-agent.grep`, `named-agent.history`, `named-agent.list`, `named-agent.delegations`, `observability.clearTrace`, `observability.dumpTrace`, `observability.page-measures`, `observability.setVerbosity`, `prompt.attest`, `prompt.attestRun`, `prompt.describe`, `provider.models`, `provider.permission-summary`, `provider.status`, `provider.summary`, `recipe.custom-list`, `recipe.list`, `run-log.list`, `run.dismissedFailed`, `run.list`, `schedules.list`, `screenshots.get`, `screenshots.list`, `script.get`, `script.list`, `security.state`, `sidepanel.getTarget`, `sidepanel.getTools`, `sidepanel.openPage`, `site-skills.get`, `skill.discover`, `skill.list`, `skills.all`, `skills.get`, `task.list`, `task.nextRun`, `thread.get`, `thread.list`, `tools.allOrigins`, `tools.consent.states`, `tools.policies`, `usage.get`, `webmcp.status`.

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

### 5.2 The `recipe.delete` Discrepancy (~9534)
- **Observed Behavior:** `recipe.delete` is declared in `OWNER_DIRECT_ACTIONS` in `extension/lib/owner-approval.js`.
- **Actual Code:** The route handler in `service-worker.js` line 9534 does not call `requireOwnerApproval(context, "recipe.delete")`; it doesn't even inspect `context`.
- **Remediation Recommendation:** Update `service-worker.js` handler for `recipe.delete` to accept `context` and invoke `requireOwnerApproval(context, "recipe.delete", id, {})`.

### 5.3 The `named-agent.set-mcp-servers` Approver Policy (Resolved in gcuw)
- **Observed Behavior:** `named-agent.set-mcp-servers` is in `OWNER_DIRECT_ACTIONS`, but absent from `DESTRUCTIVE_ACTIONS`.
- **Consequence & Resolution (chrome-agent-platform-gcuw):** Owner direct calls succeed (`isOwnerDirectApproval` is true). If a model attempts to propose an MCP server change, `createPendingApproval` intentionally fails closed with `"operation is not approvable"` because the operation is strictly owner-only and model callers must not trigger an approval flow to write server endpoints or credentials. The comment and contract were reconciled in `gcuw` (0.3.358) and pinned by `tests/mcp-approval-contract.test.ts`.
