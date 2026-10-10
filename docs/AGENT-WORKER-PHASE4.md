# Agent Worker — Phase 4 (UI ports; the single-driver lease, since removed) — what landed and what stays on the SW path

Status: implemented (2026-08-27). This is the final phase of CAP-FB-20260826-AGENT-WORKERS-01.

## What landed in Phase 4

### 1. UI ports (the "pass the port to clients" decision) — client REMOVED (CAP-FB-20260830-DEAD-CODE-CUT-01)
`lib/agent-worker-client.js` was deleted on 2026-09-02: no page ever imported
`connectAgentWorker`, no test exercised it, and the build now refuses a shipped
module nothing reaches (`scripts/check-reachability.mjs`). The design below is
kept as the record of what the client did; it comes back from history if the
owner chooses to wire the per-agent SharedWorker into a surface (option A in
that entry) rather than retire the worker path (option B).

`lib/agent-worker-client.js` — `connectAgentWorker({ agentId, onProgress, onState })` (as shipped until 2026-09-02):
- calls the SW `agent-worker.ensure` (validated), then constructs the SAME shared
  worker (`new SharedWorker(workerUrl, { type:"module", name: agentId })`) and
  holds its own live `MessagePort`;
- subscribes to the REDACTED progress stream on both the port and the
  `cap:agent:<id>` BroadcastChannel (connectionless fallback when a port can't
  be constructed, e.g. a file:// preview);
- `disconnect()` drops the port/channel — the worker survives while the offscreen
  host or another client still holds a port (keep-alive "as much as possible");
- the port is a TRANSPORT, never an authority bypass: the client NEVER issues a
  tool call over the port — actions still route through the SW's validated routes.

The NTP/sidepanel integration hook is `connectAgentWorker`; it is called on the
agent-open path (guarded, no-op when the worker isn't available). This module is
the seam — full per-surface transcript wiring is incremental and does not change
the authority model.

### 2. The single-driver browser-command lease — REMOVED (CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01)
Phase 4 originally shipped `lib/browser-command-lease.js`, a SW-owned, durable,
expiring single-holder lease that every destructive browser tool had to hold
(CAP-FB-20260826-BROWSER-SINGLE-DRIVER-01). It was removed on 2026-08-30 after
the reanalysis measured two deadlocks in a real loaded extension: the Settings
toggle acquired a 15-minute `interactive` lease nothing released, so the next
hub run was refused with "another surface is driving the browser"; and while an
agent held the lease the owner could not revoke browser control at all. The
lease never carried authority — every mutation is still authorised by the
browser-control grant (checked and mutated atomically under the grant mutex)
and fenced to its run — so it only ordered callers that were already allowed,
and no safety property was lost. `agent-worker.tool` is now a principal-gated
pass-through to the SW's real executor; there is no `agent-worker.lease` route
and no `leaseId` in the run descriptor. `tests/chrome-tools-t12.test.ts`
("LEASE GUARD") fails if a lease quietly returns.

### 3. The dispatch seam (`agent-worker.dispatch`)
A validated route that ensures the worker + posts the run descriptor. This is
the seam called by the scheduled-run alarm path (`handleAlarm`).

## What STAYS on the SW path (by design, forever)

Per docs/AGENT-EXECUTION-ARCHITECTURE.md, the SW remains the single authority
for: message routing + auth, the browser-control grant lock + permissions, alarm
scheduling, the durable-runs journal, provider/credential resolution, the run
fence, and the alive-set.

**The full `handleAlarm → worker` reroute is FLIPPED (chrome-agent-platform-mxu5).**
Scheduled tasks in `handleAlarm` route through `agent-worker.dispatch` when
the worker host is available and developer features are enabled with the keyless demo model,
falling back cleanly to SW `runTask` if developer features are disabled (the shipped default,
where provider 'demo' resolves to the real `createLocalAssistant()`), or if keyed model providers
(anthropic, google, openai, custom) or multimodal attachments are configured (which require future
SW model proxy P3).

Divergence record: Phase 4 implemented the worker infrastructure, tool bridge,
and P3 routes, but `handleAlarm` was left on `runTask` as the documented "NEXT increment"
pending decomposition of `runTask`'s fence, journal, and attribution into SW-side callbacks.
The worker host currently only implements `createDemoModel()` (the developer/test marker model).
When developer features are off (the default for fresh user profiles), provider 'demo' resolves
to `createLocalAssistant()` in the service worker. To preserve real local assistant and keyed provider
inference until the Phase 3 worker model proxy is wired, `dispatchScheduledWorkerTask` falls back
to SW `runTask` whenever developer features are off or the active provider is not demo.

Decomposition into SW-side callbacks:
1. **Attribution & Admission**: SW pre-checks `cap:restoreFence` before dispatch (skipping dispatch if
   profile restore is in progress). It admits the durable run in `durableRuns` (`admitDurableRun`)
   with `threadId`, `scheduleName`, `kind`, and `agentSurfaceRef` *before* worker dispatch so fast worker
   progress and completions can never arrive before the run is admitted (gj6kn). If pre-dispatch admission
   fails (e.g. quota/fence), dispatch is skipped and the schedule is preserved for retry (f3zyj).
   If the subsequent worker dispatch kick is refused by the worker host (`!dispatchRes?.ok`), the admitted
   run is settled as `phase: "failed"`, and `{ ok: false, error: dispatchRes?.error, skipped: true }` is returned
   to preserve the scheduled task for retry without falling back to SW `runTask` (4b066). Real fallback to
   SW `runTask` is reserved for worker-unavailability conditions evaluated during preflight (offscreen host
   unavailable, developer features off, non-demo provider, multimodal attachments, or `agent-worker.ensure` failure).
   Unnamed schedules use the `"default"` background worker identity to prevent alive-set bloat.
2. **Initial Task Row**: SW logs the task row to the agent's memory journal and `durableRuns.appendLog`.
3. **Fence & Heartbeat**: SW maintains the in-flight lock and heartbeat interval. If heartbeat fails
   or lock ownership is lost, `fence.signal` fires, revokes `runControl` immediately, and steers
   `mode: "stop-run"` (`agent-worker:abort`) to the worker. Tool execution in the SW via `agent-worker.tool`
   asserts `isFencedOut()` and fails closed with `run_fenced_out` if the fence is aborted.
4. **Progress & Journaling**: Worker streams step/tool events via `agent-worker.progress`. SW updates
   the execution heartbeat in `durableRuns`, normalizes tool rows into canonical `normalizeDurableLog` shapes,
   logs tool activity to the agent's memory journal via `resolveJournalStore`, and broadcasts to UI ports.
   Log keys use callId/nonce suffixing to prevent same-millisecond deduplication loss.
5. **Settlement**: Worker relays terminal status via `agent-worker.result`. SW settles `durableRuns`,
   unregisters from live run control, completes one-shot scheduled tasks via `markScheduledDone`,
   and resolves the pending run completion promise. The completion latch is armed before dispatch
   and latches early arrivals, ensuring fast worker completions never trigger false timeouts.
   On 120s worker timeout, the SW aborts the fence, steers `mode: "stop-run"`, settles the durable
   run as timeout, consumes one-shot payloads, and cleans up.

## Security invariants (unchanged)
- The worker holds NO authority (no storage/credential/fetch; tools are SW RPC only).
- The port is a transport, never an authority bypass.
- Redaction holds on every progress/journal path.
- Destructive browser tools are authorised by the grant + run fence in the SW (no lease; see §2).
