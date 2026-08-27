# Agent Worker Durability Architecture (Phase 3 Design)

**Document Status:** Production Design & Specification (CAP-FB-20260826-AGENT-WORKERS-01, Phase 3).  
**Target:** Shared-worker agent execution loop (Phase 2 & Phase 3 integration).  
**Authority:** Service Worker (`lib/durable-runs.js`, `background/routes/agent-worker.js`).  

---

## 1. Core Principles & Authority Boundary

Moving agent execution loops into per-agent SharedWorkers provides process, fault, and memory isolation. However, **durability and authorization must remain strictly centralized in the Service Worker (SW)**.

### Invariants
1. **Zero Direct Storage Access by Workers:** Shared workers must NEVER write to `chrome.storage` directly or mutate permissions/grants. The SW is the sole gate for persistence, credential resolution, and grant authorization.
2. **SW-Mediated Durability Journaling:** The worker streams execution events and tool logs to the SW via validated message endpoints (`agent-worker.progress`, `agent-worker.journal-append`, `agent-worker.result`).
3. **Double-Fence Idempotency:** The SW issues immutable `executionId` tokens at admission. All worker updates cite this token, ensuring stale or orphaned worker instances cannot corrupt live state or overwrite terminal results.
4. **Credential Isolation:** API keys, OAuth refresh tokens, and private host cookies never cross into the worker context. The worker receives only bounded model descriptors and dispatches provider calls through SW-secured transport bindings.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            UI (NTP / Sidepanel)                             │
│       Holds live MessagePort to SharedWorker for low-latency streaming      │
│       Subscribes to BroadcastChannel `cap:agent:<agentId>` for state        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                        Direct Port    │    Connection Request
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│               Offscreen Document (`lib/agent-worker-host.js`)                │
│       Hosts `new SharedWorker("workers/agent-worker.js", { name: id })`     │
│       Holds persistent keep-alive port for every live background agent      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                      SW IPC Messages  │  (progress / journal / result)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 Service Worker (`lib/durable-runs.js`)                       │
│    • Authority Gate: Validates caller principal ("extension")               │
│    • Run Registry: `run:<executionId>` phase, heartbeat, progressCount     │
│    • Log Storage: `run-log:<executionId>:*` durable tool execution logs      │
│    • Memory Journal: OPFS origin-keyed journal (`journalAppendOnce`)         │
│    • Durable Alive-Set: `cap:agent-workers:alive`                           │
│    • Scheduler Reconciliation: `markScheduledDone`                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Crash Model & Recovery Matrix

| Component Failure | Observable Symptom | Durable State Survived | Recovery & Reconciliation Action |
|---|---|---|---|
| **SharedWorker Crashes / OOMs** | Disconnected port; heartbeat stalls | Complete execution history in SW `run-log:<id>`, memory journal entries in OPFS, alive-set in storage | SW heartbeat timeout / alarm wake triggers `reconcileAgentWorkers()`. Offscreen host re-spawns worker; worker re-attaches to SW with `executionId` and resumes from last uncommitted step. |
| **Service Worker Terminated by Chrome** | SW lifecycle sleep | Full durable registry, OPFS memory, active SharedWorker processes in offscreen doc | SharedWorker continues current step. When worker emits next `agent-worker.progress` or `agent-worker.result`, Chrome wakes SW. SW validates `executionId` and commits payload seamlessly. |
| **Offscreen Document Reclaimed** | All worker ports close | SW durable registry, OPFS memory, durable alive-set `cap:agent-workers:alive` in `chrome.storage.local` | Next alarm or user interaction calls `reconcileAgentWorkers()` $\to$ `ensureOffscreen()`. Offscreen doc boots, recreates shared workers for all alive-set IDs, and workers re-establish state. |
| **Complete Browser Restart** | Process shutdown | OPFS memory, `chrome.storage` KV, alarms in `chrome.alarms` | On boot, `durableRuns.recover()` runs: unfinished runs transition to `paused-interruption`. Alarms wake SW $\to$ `reconcileAgentWorkers()` boots workers $\to$ `resumeInterruptedRuns()` dispatches resume requests. |

---

## 3. Resume Token Semantics & Tool Call Idempotency

### Execution Token State Lifecycle
```
[Admitted] ──▶ phase: "running"
                    │
                    ├── (Missing permission) ──▶ phase: "paused-permission"
                    │                                 │
                    │                                 ├── (Owner grants permission)
                    │                                 ▼
                    ├── (Browser crash / restart) ──▶ phase: "paused-interruption"
                    │                                 │
                    │                                 ├── (`durableRuns.resumeAfterInterruption()`)
                    │                                 ▼
                    └── (Resume Token Issued) ──▶ `activateResume(executionId, token)` ──▶ phase: "running"
```

### Invariant Rules
1. **Single-Use Resume Tokens:** Resuming a paused or interrupted run requires calling `durableRuns.resumeAfterPermission()` or `durableRuns.resumeAfterInterruption()`. The generated token is valid for exactly one activation; replay attempts fail closed.
2. **Stable Tool Call Indexing (`preToolUse`):**
   - The worker MUST call `durableRuns.preToolUse(executionId, { toolName, safety })` before executing any effectful tool.
   - The SW assigns an authoritative monotonic call index (`executionId:toolName:callIndex`).
   - If a worker crashes mid-tool, the restarted worker re-reads existing logs; already executed calls are replayed from cache rather than re-executed against external APIs.

---

## 4. Cancellation & Scheduler Integration

### Round-26 Cancellation Invariants
- **Tombstone-First Cancellation:** When an owner cancels a run via `run.cancel`, the SW writes the cancellation outbox and updates the durable record phase to `cancelled` **before** signaling the worker.
- **Worker Wind-Down:** SW sends `{ type: "agent-worker:close", agentId }` or abort signal to the worker. If the worker attempts to post further progress or results for that `executionId`, the SW rejects the commit with `{ ok: false, cancelled: true }`.
- **Scheduler Handshake (`markScheduledDone`):**
  - When a scheduled background agent finishes, `agent-worker.result` invokes `markScheduledDone(scheduleName, token)`.
  - Stale worker completions cannot clear new alarm schedules.

---

## 5. Service Worker Route Specifications (for Phase 2 Implementers)

### 1. `agent-worker.progress`
Appends an intermediate progress or tool execution log event to the durable run journal and refreshes the execution heartbeat.

- **Request:**
  ```typescript
  {
    type: "agent-worker.progress",
    executionId: string,              // e.g. "exec:550e8400-e29b-41d4-a716-446655440000"
    agentId?: string,                 // Agent identifier
    event: {
      type: "thinking" | "tool-call" | "tool-result" | "text",
      toolName?: string,
      toolArgs?: unknown,
      result?: unknown,
      text?: string,
      step?: number,
      totalSteps?: number
    },
    logKey?: string                   // Deduplication key, e.g. "tool-call:1"
  }
  ```
- **Response:**
  ```typescript
  { ok: true, executionId: string } | { ok: false, error: string }
  ```

### 2. `agent-worker.result`
Commits the final execution result, updates the run phase to `terminal`, clears active run locks, and marks scheduled tasks complete.

- **Request:**
  ```typescript
  {
    type: "agent-worker.result",
    executionId: string,
    ok: boolean,
    result?: string,
    error?: string,
    errorCategory?: string,
    errorReason?: string,
    errorAction?: string,
    logicalId?: string,               // Task ID or Thread ID
    scheduleName?: string,            // Schedule identifier if run was scheduled
    scheduleToken?: string,
    aborted?: boolean
  }
  ```
- **Response:**
  ```typescript
  {
    ok: true,
    executionId: string,
    phase: "terminal" | "cancelled",
    cancelled: boolean
  }
  ```

### 3. `agent-worker.journal-append`
Appends an entry to the agent's persistent OPFS memory store (`masterMemory`, `namedAgentMemory`, `backgroundAgentMemory`, or `siteMemory`).

- **Request:**
  ```typescript
  {
    type: "agent-worker.journal-append",
    target: "master" | `agent:${string}` | `background:${string}` | string, // Origin URL for sites
    executionId?: string,
    entry: {
      type: "task" | "result" | "tool-call" | "tool-result" | "system",
      id?: string,
      task?: string,
      result?: string,
      tool?: string,
      args?: string,
      at?: number
    },
    logKey?: string
  }
  ```
- **Response:**
  ```typescript
  { ok: true, id: string | null } | { ok: false, error: string }
  ```

---

## 6. Security & Redaction Guards

- **Principal Checking:** Every route enforces `context.principal === "extension" || context.principal === "owner-options"`. Content scripts (`principal === "page"`) or untrusted origins are immediately refused with `unauthorized_principal`.
- **String Length Capping:** All inputs (`task`, `result`, `error`, `args`, `text`) are capped and bounded (e.g. 64 KiB for results, 2048 chars for errors).
- **Automated Secret Redaction:** String payloads pass through `redactedPreview()` / `sanitizeProgressEvent()`, stripping Authorization tokens (`Bearer ...`), API keys (`key=...`, `secret=...`), and internal cookie headers before disk commitment.
