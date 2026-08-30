# DESIGN — Durable user-visible background runs (CAP-FB-20260819-DURABLE-BACKGROUND-RUNS-01)

Status: HISTORICAL DESIGN, realized by the Durable integration candidate. Public-safe:
no local paths, session/relay identifiers, credentials, or personal data. The
current-behavior map below remains the 2026-08-19 baseline at `origin/main`
`5e5c81e`; it is not a description of the integrated runtime. The implemented
source and exact accepted evidence are mapped in `docs/DURABLE-RUN-ARCHITECTURE.md`.

> Owner ask (paraphrased): task and agent runs must continue through task/view
> switches, Settings navigation, tab closure, and later reopen — the mounted
> conversation UI must never own a run. Reconnect shows bounded progress and
> exactly one terminal result; restart recovery is idempotent; stale UI owners
> cannot commit.

## 1. Historical pre-Durable behavior map (verified against the recorded base)

### 1.1 Scheduled/background runs (`task`/`recipe:<id>`)

- **Same-boot authority is in-memory**: `activeRuns` map
  (`extension/lib/scheduler.js:50,396-433`) — lost with the worker.
- The **persisted heartbeat is a storage-failure canary only**
  (`scheduler.js:18-31`): it detects that the persist path is broken so the
  run aborts; it is NOT a cross-boot liveness lease.
- **Startup clears any valid pre-boot in-flight lock by boot identity**
  (`scheduler.js:518-527`) — a lock from a previous boot is discarded, not
  waited-out; reconciliation **re-arms missing alarms**
  (`scheduler.js:566-613`).
- **Quarantine covers ambiguous scheduling-creation state**
  (`scheduler.js:195-204`), not interrupted runs; `task.list`
  (`scheduler.js:212-232`) exposes schedule payload/quarantine/cancellation
  state — there is no visible interrupted-run or recovery phase.
- **At-least-once duplicate window (exact)**: `runTask` journals the result
  (`service-worker.js:1402`) and a one-shot schedule is removed only AFTER
  `runTask` returns. Worker loss between the journal commit and the schedule
  removal leaves the payload eligible for re-arm and RERUN — a duplicate
  execution whose side effects (page actions, messages) are not idempotent.
  Scheduled behavior is therefore durable-but-at-least-once, never "exactly
  once".

### 1.2 Ad-hoc runs (composer/thread `agent.run`)

- `agent.run` first creates/continues a **durable thread**
  (`service-worker.js:2155-2168`; `threads.js:145-170` persists the user
  message + `status:"running"` in both body and index), THEN enters `runTask`.
- `runTask` writes separate **master-journal** task/result rows
  (`service-worker.js:1336-1355`, `:1402`); the handler separately copies
  tool/result/error state into the **thread** (`service-worker.js:2230-2268`).
- Reopened task UI reads `thread.get`, not the master journal
  (`extension/ntp/ntp.js:638-704`).
- So there IS durable ad-hoc state (thread + journal), but **no canonical
  durable run registry/lease**, and SW loss can leave three exact crash
  windows:
  1. durable thread marked `running` before the journal task append;
  2. journal task row without a journal result row;
  3. journal result without the corresponding thread assistant/status commit.
- **Direct Site Agent `agent.delegate` does NOT go through `runTask`**: it
  runs through its own `withRunLock`/worker path
  (`service-worker.js:3980-4070`) with its own execution id (`:4024`). Any
  registry written by `runTask` alone would miss direct delegations.

### 1.3 Shared truths

- Tab close/view switch is page-only; the SW run continues (proven by the
  run-status lifecycle reload journey); surfaces are fenced by
  `run-surface-owner` (a stale surface token cannot commit DOM effects).
- A new `agent-progress` port receives ONLY future broadcasts
  (`service-worker.js:352-381`); `conversation.js:28-49` has no initial-state
  request/replay — a reopened page cannot distinguish "still running" from
  "lost".
- MV3 timers do not guarantee worker survival: heartbeats are **freshness
  evidence and fail-closed detection**, not a liveness guarantee. The resolved
  policy durably pauses an interrupted execution and automatically reclaims the
  same execution ID after restart. A cancellation tombstone always overrides
  this recovery and can never be resumed.

## 2. Design — durable run registry (the run authority lives in the SW, durably)

### 2.1 Canonical identity (no conflation)

- **Canonical run id**: SW-issued immutable `executionId` (already unique per
  attempt) — the ONLY registry key component: `run:<executionId>`.
- Separate fields, never conflated: `clientCorrelationId` (the page-generated
  UI `runId`, `conversation.js:158-163`), `threadId` (logical conversation),
  `scheduleName` (for scheduled runs). Retries attach by correlation id;
  authority is by execution id.

### 2.2 Authority isolation (model-proof)

- The master store reserves exact registry keys + the `thread:` prefix only
  (`memory.js:30,235-242`) — a model-reachable `memory_set` could otherwise
  forge `run:*`. The design therefore REQUIRES a **newly reserved trusted
  prefix** (e.g. reserve `run:` on the master store exactly as `thread:` is
  reserved) with mutation only via the trusted path (`setTrusted` from SW
  code) — no model-reachable route may write it.

### 2.3 Run record + phases

```
run:<executionId> = { executionId, clientCorrelationId, threadId?,
  scheduleName?, kind: "task"|"agent"|"scheduled"|"delegate", agentId?,
  taskPreview (bounded, redacted),
  phase: running|settling|resume-dispatching|paused-interruption|paused-permission|paused-provider-change|paused-side-effect-uncertain|cancel-requested|cancelled|terminal,
  revision (monotonic, see §2.5), startedAt, heartbeatAt, progressCount,
  resumeAttemptCount (bounded), resumeState?, retentionPolicyVersion: "run-retention-v2", cancellation?, pause?,
  logBytes?, logCompacted?: { at, rowsDropped, bytesBefore, bytesAfter },
  terminal?: { ok, at, summary } }
```

- Written by a NEW registry helper invoked from BOTH `runTask` and the
  `agent.delegate` path (§1.2) — direct site-agent delegations are IN SCOPE
  (their progress-provenance question stays OPEN, §4).
- `heartbeatAt` renewed on run activity — freshness evidence only (§1.3).

### 2.4 Exactly-once terminal commit protocol (explicit)

The `settling → terminal` transition and the journal/result writes are bound
into ONE protocol; no step may be observed without its counterpart:

1. **Idempotent journal result**: the journal result row carries the
   immutable `executionId` as its idempotency key; appending the same
   execution's result twice is a no-op (checked under the journal lock).
2. **CAS run transition**: `terminal` is written via compare-and-swap on the
   run record (`revision` precondition) — only the first terminal wins.
3. **Durable outbox with the recoverable payload**: before any dependent
   write, a single-key outbox record `{executionId, terminal: {ok, at,
   summary}, threadMessage: {role, content-ref}}` is committed — the FULL
   recoverable terminal payload (or a durable reference to an
   already-persisted payload object), never only a digest, so recovery can
   reconstruct the journal result row AND the thread assistant message
   without the crashed run. The thread assistant/status terminal append is
   **idempotent by `executionId`** (the thread commit records the execution
   id; a repeated append for the same execution is a no-op under the thread
   lock) — the journal, the thread, and the registry all key idempotency on
   the same immutable execution id. Outbox entries are removed only AFTER
   journal row + thread commit + CAS transition are all durably complete
   (acknowledged), and removal is itself a journaled boundary.
4. **Fault matrix (acceptance)**: crash injection at EVERY persistence
   boundary — before outbox / after outbox before journal / after journal
   before thread commit / after thread commit before CAS / after CAS before
   outbox removal / after outbox removal — each asserted to yield exactly one
   terminal result and a consistent thread/journal/registry triple.

### 2.5 Reconnection without the snapshot/live race

- New route `run.list` → active + recently-terminal records (bounded,
  redacted previews).
- Every run mutation bumps a **monotonic per-run `revision`**; progress
  broadcasts carry `{executionId, revision}`. On port connect: register the
  port → start buffering live events → send the snapshot → drain buffered
  events whose `revision` is newer than the snapshot's — the client rejects
  any event with `revision ≤` last applied (stale-event rejection). This
  closes the replay-vs-live regression race explicitly.
- A reopened thread attaches its banner by `threadId` → execution lookup,
  through the existing `run-surface-owner` fence.

### 2.6 Recovery sweep (idempotent, restart-safe)

On SW startup, in this exact order:
1. **Outbox reconciliation FIRST**: every outbox entry is completed to its
   full terminal state (journal result row, idempotent thread commit, CAS
   `terminal` transition, then outbox removal) BEFORE any interruption-recovery
   decision — a stale `settling` record with an outbox entry is completed,
   never resumed as unfinished (never both result and interruption retry).
2. **Interruption recovery SECOND**: any `running|settling` record not owned by
   the current boot and with no terminal outbox becomes `paused-interruption`.
   Startup reclaims that same execution ID and request automatically. A durable
   `cancel-requested` tombstone is reconciled to `cancelled` first and is never
   eligible for either automatic or manual resume.
3. Scheduled tasks reconcile via the EXISTING scheduler boot-clear/re-arm
   semantics (§1.1), which the registry must not duplicate.

## 3. Original acceptance criteria (implemented and scoped-proof accepted)

1. Ad-hoc run + tab close + reopen: reconnect shows the run in-flight (via
   `run.list`/port replay) within one bounded interval; exactly one terminal
   result; no duplicate.
2. Genuine SW kill mid-run: the sweep marks the run `paused-interruption`,
   then automatically resumes the same immutable execution ID from its private
   recoverable request; no stale mounted UI owns the execution.
3. View-switch matrix (hub → thread → Settings → Directory → thread): run
   record untouched; banners reattach via the fence; stale surfaces cannot
   commit (existing fence regression suite stays green).
4. Heartbeat freshness advances while the run is active (asserted on the
   durable record) — as detection evidence, never as a survival claim.
5. Exactly-once terminal across the full fault matrix (§2.4.4): never both an
   ordinary and cancellation terminal, never terminal without a journal/thread
   result, never two cancellation results.
6. Retain-all v1: run records and per-run log rows are never automatically
   evicted, compacted, truncated, age-expired or silently cleared. Storage or
   quota rejection fails a new acceptance without modifying old runs; changing
   policy requires an explicit versioned migration.
7. Scheduled-run duplicate window (§1.1) is either closed (schedule removal
   joined into the §2.4 protocol) or explicitly surfaced; never silently
   at-least-once.
8. Direct site-agent `agent.delegate` runs appear in the registry with the
   same identity/replay semantics.

## 4. Resolved owner policy (2026-08-20)

1. **Explicit cancellation is terminal**: the owner UI confirms that restart is
   impossible and logs remain, then persists an owner-authority tombstone. The
   exact live abort callback fires immediately after that CAS and before outbox,
   journal or thread completion; a thrown callback gets at most one immediate
   idempotent retry outside the registry mutex, with both errors and the final
   outcome recorded, while recovery still finishes cancellation. Repeated cancel is idempotent. Neither automatic
   recovery nor `run.resume` may restart that execution ID; only a new explicit
   run request creates a new ID.
2. **Retain every run; bound the log detail** (superseded 2026-08-30 by
   CAP-FB-20260830-RUN-LOG-COMPACTION-01 — the explicit versioned migration this
   item required): `run-retention-v2` is `bounded` by default — the newest 10
   executions per thread and the newest 500 overall (32 MiB) keep their full
   log, older logs are compacted to one honest summary row — with
   `automaticEviction:false` and `explicitClearOnly:true` unchanged: no
   execution record is ever removed by policy. "Keep every run log"
   (`retain-all`) is the explicit opt-in in Settings. Every run/log row binds
   its stamp; v1 rows stay readable, v1 records migrate on read, legacy
   unversioned records migrate non-destructively, and unknown future versions
   fail closed. See docs/DURABLE-RUN-ARCHITECTURE.md.
3. **Interruption recovery is bounded and fail-safe**: UI/view/tab teardown does
   not own execution. Before any tool progress, worker/browser interruption may
   automatically prepare a tokenized same-ID dispatch. It becomes `running` only
   after the route claims that token; refusal re-pauses visibly and the third
   failed or crash-interrupted dispatch commits exactly one terminal resume
   failure rather than permitting attempt four or an indefinitely paused run.
   After tool progress, replay safety is unknown, so the run becomes
   `paused-side-effect-uncertain` with `requiresOwnerDecision: true` and only explicit owner Retry
   or Cancel may continue. The execution ID is supplied as a deterministic
   idempotency key, but universal external exactly-once behavior is not claimed.
4. **Permission/provider pause is distinct**: the resume request binds provider,
   model and narrow origin scope without secrets. A missing matching host grant
   becomes `paused-permission`; provider/override changes become
   `paused-provider-change` and require explicit owner confirmation rather than
   silently rerouting. There is no per-invocation nagging or automatic broad grant.
5. **Owner controls and logs**: the subscribed run-registry component renders
   native Cancel/Resume/View logs buttons with task-bound names, confirmation,
   pending suppression, focus-visible styling and polite status/error feedback.
   Full retained logs remain owner-only through `run.logs`.

## 5. Acceptance fixtures (for the future harness)

- `fixture-run-adhoc-close` — ad-hoc run + tab close + reopen; reconnect truth.
- `fixture-run-sw-kill` — genuine SW termination before progress; bounded tokenized same-ID recovery.
- `fixture-run-side-effect-counter` — synthetic mutating counter interrupted after uncertain completion; no blind replay, explicit Retry only.
- `fixture-run-owner-controls` — keyboard Cancel/Resume/View logs, confirmations, duplicate suppression, focus and AX names.
- `fixture-run-provider-switch` — provider identity/scope mismatch pauses visibly; no implicit reroute.
- `fixture-run-quota-retain-all` — forced quota rejection preserves every old log and leaves no stranded run/index row; replaces the predecessor v13 200-cap journey.
- `fixture-run-view-switch` — hub/thread/Settings/Directory matrix.
- `fixture-run-heartbeat` — heartbeat freshness on the durable record.
- `fixture-run-fault-matrix` — crash at every §2.4 persistence boundary.
- `fixture-run-stale-surface` — stale conversation surface fenced on commit.
- `fixture-run-delegate` — direct site-agent delegation appears + reconnects.
- `fixture-run-scheduled-dup` — the §1.1 duplicate window under SW kill
  between journal commit and schedule removal.
