# Agent Worker — Phase 4 (UI ports; the single-driver lease, since removed) — what landed and what stays on the SW path

Status: implemented (2026-08-27). This is the final phase of CAP-FB-20260826-AGENT-WORKERS-01.

## What landed in Phase 4

### 1. UI ports (the "pass the port to clients" decision)
`lib/agent-worker-client.js` — `connectAgentWorker({ agentId, onProgress, onState })`:
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
the seam the alarm path will call.

## What STAYS on the SW path (by design, forever)

Per docs/AGENT-EXECUTION-ARCHITECTURE.md, the SW remains the single authority
for: message routing + auth, the browser-control grant lock + permissions, alarm
scheduling, the durable-runs journal, provider/credential resolution, the run
fence, and the alive-set.

**The full `handleAlarm → worker` reroute is NOT yet flipped.** The scheduled-run
path still calls `runTask(...)` in the SW because `runTask` carries the SW-authority
machinery the worker must NOT reimplement: the in-flight lock + heartbeat, the
run fence (round-26 abort semantics), the durable-run admission/journal commit,
and attribution. Ripping it out in one shot would risk the exact "one bad move
kills every background agent" fault the migration exists to avoid. The reroute is
the NEXT increment: decompose `runTask`'s fence/journal/attribution into
SW-side callbacks the worker's loop already targets (via the P3 routes
`agent-worker.progress/result/journal-append`), then point `handleAlarm` at
`agent-worker.dispatch`. The dispatch route + lease + progress routes are proven
and are the wire-ready seam.

## Security invariants (unchanged)
- The worker holds NO authority (no storage/credential/fetch; tools are SW RPC only).
- The port is a transport, never an authority bypass.
- Redaction holds on every progress/journal path.
- Destructive browser tools are authorised by the grant + run fence in the SW (no lease; see §2).
