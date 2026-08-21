# Durable run architecture

## Status and evidence boundary

This reference describes the implementation candidate at commit
`ac1c4fe6c058961a7e963bdc2d58ae435e7586a9`, tree
`e175833c6f5ee9425a7b5a69dca8d082e15a89d6`, release `0.2.110`. The candidate
is pending integration onto public main; public main was
`300bea14c68472340a38a21a583d62e286c008a4` when this document was written.
The source citations below resolve against that candidate, not against public
main.

Review iterations v1-v39 produced no final whole-product authority. Their
reports are not acceptance evidence. The candidate's static tests exercise the
registry, fault boundaries, quota compensation, routes, and page-local owner
fence, but they do not prove the loaded extension UI. No browser screenshots
for the seven-step sequence in [Browser proof required before landing](#browser-proof-required-before-landing)
are claimed to exist.

The candidate establishes these boundaries:

- A mounted NTP, thread, Settings view, or other page may start a run and issue
  owner controls, but it does not own execution. `runTask` and direct
  `agent.delegate` dispatch under the MV3 service worker, while OPFS holds the
  recoverable authority.
- The service worker can be terminated. A 15-second heartbeat records freshness;
  it does not keep the worker alive or prove uninterrupted execution.
- The outbox makes terminal journal, thread, and run-record projections
  idempotent by `executionId`. It does not make arbitrary browser or remote tool
  side effects exactly once.
- Retain-all applies to durable run records, run logs, and retained payloads.
  The compatibility journal and thread projections remain bounded.

## Authority and dispatch

`runTask` serializes master and delegated worker execution with `withRunLock`,
then waits for startup recovery, creates or reuses one service-worker-issued
`executionId`, builds the private resume request, and calls `admitDurableRun`
before provider dispatch. Direct site-agent delegation follows the same durable
admission and settlement path rather than bypassing the registry.

Source:

- `extension/background/service-worker.js:347-359` — `withRunLock`
- `extension/background/service-worker.js:637-641` — `newExecutionId`
- `extension/background/service-worker.js:1216-1309` —
  `providerResumeIdentity` and `runTask` admission/provider gate
- `extension/background/service-worker.js:4400-4650` — direct
  `handlers["agent.delegate"]`
- `extension/lib/durable-quota.js:28-36` — `admitDurableRun`
- `tests/durable-runs.test.ts:439-474` — both dispatch paths are wired through
  admission, heartbeat, and settlement

Logical identifiers remain metadata: `clientCorrelationId`, `threadId`,
`scheduleName`, and the task ID can repeat. Authority keys use the immutable
`executionId`. `validExecutionId` accepts the service-worker UUID form and a
bounded `exec_…` form used by tests, while rejecting prototype names and path
syntax (`extension/lib/durable-runs.js:75-80`;
`tests/durable-runs.test.ts:585-591`).

### Three fences

1. **Boot fence.** Each registry instance has a new `bootId`. `heartbeat`
   accepts only an execution in the current boot's active set whose persisted
   record has the same `bootId` and a `running` or `settling` phase
   (`extension/lib/durable-runs.js:100-102,550-566`). A new worker must recover a
   pre-boot record before it can reactivate the same execution.
2. **Revision fence.** `writeRecord` increments the per-run `revision` and uses
   the record's prior revision plus the OPFS key version for compare-and-swap.
   Delayed registry updates cannot overwrite a newer revision
   (`extension/lib/durable-runs.js:207-228`).
3. **UI owner fence.** `createRunSurfaceOwner().claim()` returns a monotonic,
   page-local token. `owns` and `commit` refuse delayed DOM writes after another
   surface claims ownership. The old execution can continue and journal in the
   service worker (`extension/shared/run-surface-owner.js:1-19`;
   `extension/ntp/ntp.js:593-596,658-715,1260-1313`;
   `tests/run-surface-owner.test.ts:7-24`).

The in-memory `runMutex` and aborter map are same-boot execution controls. OPFS
records, revisions, resume tokens, cancellation tombstones, and outboxes are the
cross-boot authority.

## OPFS records and projections

All keys below are values in an OPFS-backed memory store. Durable run authority
uses the trusted master store; `journalTarget` can point terminal journal
projection at master, named-agent, background-agent, or canonical HTTP(S)
site-agent memory.

| Key | Writer/reader | Contents and lifetime |
| --- | --- | --- |
| `run-registry` | `addToIndex`, `removeFromIndexExact`, `list` | Ordered execution-ID index, changed with key-version CAS. |
| `run:<executionId>` | `writeRecord`, `readRecord` | Authoritative phase, `bootId`, monotonic `revision`, heartbeat, progress count, policy, pause/cancel/terminal metadata, and a private admission receipt. |
| `run-outbox:<executionId>` | `settle`, `ensureCancellationOutbox`, `processOutbox` | Recoverable terminal or cancellation packet. It remains until all projections and the terminal log are acknowledged. |
| `run-log:<executionId>:<sha256>` | `appendLog`, `listLogs` | Content-addressed log row keyed by the SHA-256 of its idempotency key. Large rows point to retained payload chunks. |
| `run-resume:<executionId>:manifest` and numbered chunks | `persistResumeRequest`, `readResumeRequest` | Private dispatch request, chunked at 64 KiB string boundaries. Public run projections expose only `resumeAvailable`. |
| `run-payload:<executionId>:<id>:manifest` and numbered chunks | `persistJsonPayload`, `readJsonPayload` | Full terminal bodies and oversized log bodies. Journal/thread text remains a bounded projection. |
| `journal` | `journalAppendOnce`, `journalCommitCancellation`, `journalCompensateExecution` | Idempotent terminal audit projection plus ordinary bounded activity rows. The journal is capped at 500 rows and 200 KiB. |
| `threads` and `thread:<threadId>` | `commitThreadTerminal`, `commitThreadCancellation` | Conversation index and body. Terminal messages are idempotent by `executionId`; cancellation replaces an incomplete ordinary terminal projection. |

Source: `extension/lib/durable-runs.js:17-45,207-368`;
`extension/lib/memory.js:610-834`; `extension/lib/threads.js:282-405`.
Large-request and full-terminal retention are covered by
`tests/durable-runs.test.ts:881-917`; retain-all policy and restart retention by
`tests/durable-runs.test.ts:593-606,919-952`.

`RUN_RETENTION_POLICY` names this behavior `run-retention-v1`, disables automatic
run compaction/eviction, and requires explicit clearing. That policy can exhaust
the store's existing per-value, per-store, or global limits; it is an audit
choice, not unlimited storage (`extension/lib/durable-runs.js:29-37`;
`extension/lib/memory.js:20-53`).

## Settlement order

`settle` and `processOutbox` serialize terminal work under the registry mutex.
The actual write order is:

1. Persist the full terminal body under `run-payload:<executionId>:terminal:*`.
2. Write `run-outbox:<executionId>` with the payload reference, terminal summary,
   journal row, and optional thread projection.
3. Move a still-`running` record to `settling` with revision CAS.
4. Append the terminal journal row once by `executionId`, or replace it with the
   cancellation row when a cancellation tombstone won.
5. Commit the thread terminal once by `executionId`, or replace it with the
   cancellation projection.
6. CAS the run record to `terminal` or `cancelled` and remove it from the
   same-boot active set.
7. Write the retained terminal log, rewrite the outbox with `acknowledgedAt`,
   then delete the outbox.

Source: `extension/lib/durable-runs.js:568-628,931-1006`;
`extension/lib/memory.js:636-653,812-834`;
`extension/lib/threads.js:282-405`.

Recovery processes cancellation authority and existing outboxes before it
classifies interrupted runs. Replaying the outbox repeats journal/thread work
safely and repairs the remaining projection. The injected boundaries after
outbox, journal, thread, registry CAS, outbox acknowledgement, and outbox removal
produce one terminal journal row and one thread row in the static harness
(`extension/lib/durable-runs.js:1009-1070`;
`tests/durable-runs.test.ts:318-393`). This is exactly-once **terminal
projection**, not universal exactly-once execution.

## Run states and recovery decisions

| Phase | Meaning | Next authority decision |
| --- | --- | --- |
| `running` | Current boot owns execution; heartbeat and progress revisions may advance. | Settle, pause, cancel, or classify after worker loss. |
| `settling` | Terminal outbox exists or is being projected. | Startup finishes the outbox before interruption classification. |
| `paused-interruption` | A prior boot ended before durable tool progress. | Startup may prepare an automatic same-ID resume. |
| `paused-side-effect-uncertain` | The worker ended after `progressCount > 0`. An external effect may have completed. | No blind replay; owner must confirm Retry or Cancel. |
| `paused-permission` | The exact retained provider scope is missing. | Permission addition can trigger automatic resume. |
| `paused-provider-change` | Current provider identity differs from the retained binding. | Owner confirmation is required before rebinding and resume. |
| `resume-dispatching` | A bounded, tokenized resume claim is being handed to a dispatch route. | Activate only with the matching token; failure returns to the prior pause or terminalizes at the limit. |
| `cancel-requested` | Explicit-owner tombstone is durable; live abort outcome is recorded before cancellation outbox creation. | Cancellation outbox replaces any incomplete ordinary outcome. |
| `cancelled` | Terminal cancellation for this execution ID. | A retry requires a new run and new `executionId`. |
| `terminal` | Success, ordinary failure, aborted result, or exhausted-resume failure is projected. | Read logs; no resume. |

`recover` treats pre-boot `running`, `settling`, and `resume-dispatching` records
without outboxes as interrupted. Zero progress becomes `paused-interruption`;
positive progress becomes `paused-side-effect-uncertain`. Resume preparation
increments `resumeAttemptCount`, writes a one-use token, and terminalizes the
third failed or crash-interrupted dispatch through the same outbox path
(`extension/lib/durable-runs.js:807-929,1009-1070`;
`tests/durable-runs.test.ts:772-878`).

After registry recovery, `resumeInterruptedRuns` dispatches safe interruptions.
`chrome.permissions.onAdded` and the boot continuation call
`resumePausedPermissionRuns`. Provider binding equality is checked again in
`activateResume`; changed providers pause unless the owner explicitly allows the
change (`extension/background/service-worker.js:4705-4781`;
`extension/lib/durable-runs.js:836-880`;
`extension/lib/durable-provider-dispatch.js:9-47`).

Cancellation is owner-only at the message route. The registry first persists
`cancel-requested`, invokes the exact live abort callback with one bounded retry,
persists that attempt, then creates and processes the cancellation outbox. A
restart can reconstruct a missing cancellation outbox from the tombstone
(`extension/background/service-worker.js:3577-3647`;
`extension/lib/durable-runs.js:630-772,1017-1028`;
`tests/durable-runs.test.ts:608-769`).

## Exact native-quota compensation

Only a browser-native `QuotaExceededError` authorizes quota compensation.
Provider errors or text that merely says “quota” cannot authorize deletion
(`extension/lib/durable-quota.js:9-36`;
`tests/durable-runs.test.ts:170-177,285-296`).

There are two compensation points:

- **Admission failed inside `start`.** Auxiliary execution keys are deleted
  first. `removeFromIndexExact` removes only this execution and preserves the
  registry's prior absent-versus-present-empty shape plus concurrent IDs. The
  readable run record is deleted last, and a final scan verifies no execution
  keys or index entry remain (`extension/lib/durable-runs.js:371-452`;
  `tests/durable-runs.test.ts:119-168,954-974`).
- **Admission succeeded, but a later zero-progress write hit native quota.**
  `rollbackUnprogressedQuota` trusts the persisted record rather than caller
  claims. It refuses deletion if progress is nonzero, phase is not `running`,
  owner decision is required, cancellation exists, or authority is unreadable.
  For a proven zero-progress run it deletes auxiliary keys, compensates the
  journal from its exact receipt, CAS-removes the index entry, CAS-deletes the
  run record, and verifies zero remnants
  (`extension/lib/durable-runs.js:454-548`;
  `extension/background/service-worker.js:1490-1499,1589-1605,4627-4638`;
  `tests/durable-runs.test.ts:180-316`).

`journalAppendWithReceipt` captures existence, value, key version, post-state,
and execution ID. `journalCompensateExecution` can restore the exact prior state
or preserve proven later foreign appends; same-value ABA, generation changes,
unprovable concurrency, and CAS mismatch fail closed with authority retained
(`extension/lib/memory.js:636-809`;
`tests/memory.test.ts:324-375`).

## Reconnect: register, buffer, snapshot, drain

A page connects the `agent-progress` runtime port. The service worker registers
it for live progress and calls `durableRuns.attachPort`. The registry subscribes
the port before reading OPFS, buffers mutations during that read, posts one
`run-snapshot`, and drains only buffered events with a revision greater than the
snapshot revision. After the drain, live updates post directly. The page keeps a
per-execution map and rejects updates whose revision is less than or equal to
the current record.

Source: `extension/background/service-worker.js:361-405`;
`extension/lib/durable-runs.js:1083-1115`;
`extension/shared/conversation.js:24-88`;
`tests/durable-runs.test.ts:419-437`.

The NTP subscribes the shared `<durable-run-registry>` to these snapshots and
wires its Cancel, Resume/Retry, and View logs events to owner routes
(`extension/ntp/ntp.js:25-45`;
`extension/shared/components.js:5184-5292`;
`tests/components.test.ts:75-128`). Reconnection repairs durable run status; the
thread body still comes from `thread:<threadId>`.

## Security boundaries

- `memoryStore().set` rejects model writes to `run-registry`, `threads`, and
  every `run:`, `run-outbox:`, `run-log:`, `run-resume:`, `run-payload:`, and
  `thread:` prefix. Internal code uses `setTrusted`
  (`extension/lib/memory.js:20-45,246-256,407-430`;
  `tests/memory.test.ts:267-293`).
- Public run records omit `journalTarget`, resume request/body/reference, and
  the registry admission receipt. Task previews are bounded and redact common
  bearer/credential patterns (`extension/lib/durable-runs.js:64-98`). That
  pattern is not a general-purpose secret scrubber for arbitrary tool logs;
  provider keys must never enter log events.
- `run.cancel`, `run.resume`, and `run.logs` accept only extension or exact owner
  Options principals. Content-script routes are allowlisted and cannot reach
  durable administration (`extension/background/service-worker.js:3577-3647,4783-4845`).
- Provider resume bindings contain provider, model, requested host scope, and a
  local flag, but no API key. Permission scope must match the retained binding
  before a run can pause or resume
  (`extension/background/service-worker.js:1216-1223`;
  `extension/lib/durable-runs.js:774-805,859-880`).
- Site-agent delegation canonicalizes HTTP(S) origins, captures enrollment
  generation, and rechecks it before worker dispatch and the site-journal
  projection. Master-owned terminal authority does not recreate a disenrolled
  site store (`extension/background/service-worker.js:4400-4618`;
  `extension/lib/memory.js:55-76`).
- The outbox protects CAP's own terminal projections. Tool implementations still
  need their own idempotency or transaction boundary; after observed tool
  progress, recovery therefore pauses for an owner decision.

## Source and test index

| Claim | Candidate implementation | Static verification |
| --- | --- | --- |
| Identity, boot, revision, heartbeat | `extension/lib/durable-runs.js:75-102,195-240,550-566` | `tests/durable-runs.test.ts:395-417,585-591` |
| Outbox and crash replay | `extension/lib/durable-runs.js:568-628,931-1070` | `tests/durable-runs.test.ts:318-393` |
| Snapshot-buffer-drain | `extension/lib/durable-runs.js:1083-1115`; `extension/shared/conversation.js:24-88` | `tests/durable-runs.test.ts:419-437` |
| Cancel and bounded resume | `extension/lib/durable-runs.js:630-929`; `extension/background/service-worker.js:3577-3647,4705-4781` | `tests/durable-runs.test.ts:608-878,976-996` |
| Permission/provider pause | `extension/lib/durable-provider-dispatch.js:9-47`; `extension/lib/durable-runs.js:774-880` | `tests/durable-runs.test.ts:476-583,772-793,881-905` |
| Retention and payload chunking | `extension/lib/durable-runs.js:29-37,243-368` | `tests/durable-runs.test.ts:593-606,881-952` |
| Exact quota compensation | `extension/lib/durable-quota.js`; `extension/lib/durable-runs.js:371-548`; `extension/lib/memory.js:636-809` | `tests/durable-runs.test.ts:119-316,954-974`; `tests/memory.test.ts:324-375` |
| UI owner token | `extension/shared/run-surface-owner.js`; `extension/ntp/ntp.js:593-715,1260-1313` | `tests/run-surface-owner.test.ts:7-24` |
| Owner controls | `extension/shared/components.js:5184-5292`; `extension/ntp/ntp.js:25-45` | `tests/components.test.ts:75-128`; `tests/durable-runs.test.ts:976-996` |

## Browser proof required before landing

Landing remains blocked until a loaded candidate at exact commit `ac1c4fe` is
driven through this sequence in Chrome. Capture all seven PNGs under
`test-artifacts/durable-runs/`, bind the evidence manifest to the candidate
commit and loaded extension bytes, and retain console/runtime assertions next
to the images. A screenshot is required for every step; raw assertions do not
replace a missing visible state.

Static inspection already identifies a step-4 risk: the candidate NTP recognizes
an omnibox hash but has no `#tasks` hash route, the registry is mounted inside
the thread view, and `<durable-run-registry>` does not render `progressCount`
(`extension/ntp/ntp.js:1686-1695`; `extension/ntp/ntp.html:664-679`;
`extension/shared/components.js:5236-5251`). The required browser run must treat
a missing task-panel route or visible counter as a failure rather than replacing
the visible assertion with raw `run.list` state.

1. **`01-task-start.png`** — on
   `chrome-extension://<id>/ntp/ntp.html`, type a multi-step task and click Run.
   - Visible: composer shows the prompt and active state; the user bubble is in
     the thread; status changes from idle to starting/working.
   - Raw: the send response exposes one valid `executionId`; `run.list` returns
     that ID in `running`; its `threadId` matches the opened thread; no console
     error occurred.
2. **`02-task-running-progress.png`** — remain in the thread while a real tool
   call is in flight.
   - Visible: a structured tool-call card shows `running`; the thinking
     indicator is active.
   - Raw: the same run's `heartbeatAt`, `revision`, and `progressCount` advance;
     retained logs contain the matching `tool-call`; there is still no terminal
     thread message for the execution.
3. **`03-navigate-away.png`** — navigate to
   `chrome-extension://<id>/options/options.html` while the run remains active.
   - Visible: Settings, including provider and model selectors, is fully
     rendered; the old thread is not visible; no broken overlay appears.
   - Raw: the run retains the same `executionId` and remains nonterminal; a
     delayed old-thread callback cannot change the Settings DOM or the newly
     selected surface; console and unhandled-rejection collections remain empty.
4. **`04-task-panel-background-continues.png`** — open
   `chrome-extension://<id>/ntp/ntp.html#tasks` before the tool finishes.
   - Visible: `<durable-run-registry>` shows the active card with phase
     `running`, redacted task preview, the execution ID, an enabled native
     “Cancel <task>” button, and a visibly advancing background tool counter.
   - Raw: the card's `data-execution-id` equals the original ID; `run.list`
     reports a larger `progressCount`/revision than step 2; no second execution
     ID or duplicate card exists. If the counter is not rendered, this step
     fails even if the raw count advances.
5. **`05-return-to-thread.png`** — reopen
   `chrome-extension://<id>/ntp/ntp.html?thread=<id>`.
   - Visible: complete prior history appears once; no user/result bubble or tool
     card is duplicated; current tool activity resumes visibly.
   - Raw: reconnect traffic records `run-snapshot` before drained `run-update`
     events; every drained revision is greater than the snapshot revision;
     applied revisions are strictly increasing for the execution ID.
6. **`06-terminal-result-logs.png`** — wait for completion, then click View logs.
   - Visible: one final assistant bubble has status `done`; the status banner is
     complete; the run card shows `terminal`; the focusable
     `<pre class="logs">` displays retained `accepted`, `tool-call`,
     `tool-result`, and `terminal` rows.
   - Raw: `run.list` reports `terminal`; the journal has one terminal row for
     the execution; the thread has one execution-bound terminal message;
     `run-outbox:<executionId>` is absent; terminal payload/log retrieval returns
     the full retained result.
7. **`07-reload-persistence.png`** — hard reload the NTP with F5 or
   `location.reload()`.
   - Visible: the sidebar container reports `data-durability="durable"`; the
     full conversation, final assistant result, and tool cards are restored;
     the run registry keeps the same execution ID; no zombie spinner or
     duplicate card is visible.
   - Raw: after reconnect, the same terminal record and one terminal thread
     message remain; retained log types and payload are unchanged; no new
     execution ID was created; console and unhandled-rejection collections are
     empty.

Static green tests can support these assertions, but only the loaded-extension
sequence can show that navigation, reconnection, owner controls, and restored
DOM state are wired to the candidate bytes.
