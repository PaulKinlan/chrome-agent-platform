# Durable run architecture

## Status and evidence boundary

This reference describes the independently reviewed and browser-proven Durable
source at commit `dd41258f7401dda8ccf8b561b955b5f4b919baa0`, tree
`80ca97f0c55cbd0e8a2c306b82764f3a4aa1a860`, release `0.2.113`. That exact
source is accepted for integration onto public main
`7f1f7aee216c2a87a69df584f059d526bbf07a4c` (public release `0.2.109`). Source
citations below resolve against `dd41258f`; the final integration intentionally
changes only integration/version documentation around byte-identical Durable
runtime and test blobs.

Review iterations v1-v39 remain candid history and produced no final
whole-product authority. They are not acceptance evidence. Final source reviews
independently passed the exact quota, live Tasks-sidebar, terminal owner-thread
projection, and hard-reload recovery commits. A separate independent evidence
review accepted the exact loaded-extension seven-shot journey as
`PASS_FOR_INTEGRATION`. This accepts the Durable product delta for integration;
it does **not** accept unrelated product areas or declare whole-product release
acceptance. The current-main integration diff still requires independent review,
and the browser-security suite remains a post-integration residual gate because
this integration run is explicitly no-Chrome.

The accepted evidence binds one host-backed loaded-MV3 journey to the exact
source tree and loaded runtime bytes:

- Evidence execution: `exec:a2a68c2b-b80e-4f68-9309-b75574953b4c`
- Thread: `t_1787316135082_vbvmtdr0`
- Source archive SHA-256: `3e644a31c72aba2b3363aede08694a423f7da01542372c8c0b427f7271bbd520`
- Active service worker SHA-256: `e1f11b0dff7b0359278ee13aa1fdf38d29278f613c7c8ff13f5eaf7dc519a9d9`
- Active Options bundle SHA-256: `eced6094f26e1348ec304a260ac135bedd72bfbc8602fadcaa24e182e26e775b`
- Evidence manifest SHA-256: `787e5adb5fa1796f6bb7650ab796f4bf6b453418fe6fb923806e2b000e4e0047`
- Evidence checksum index SHA-256: `785ab1b42c32ead048ac5884459b545804ececbb54b523fcfa5772bfb2819c9f`
- Root bindings SHA-256: `95c86d9683ed274fa9f79ed6affcb822ea4f21cace582d0948ea11f2785a9734`

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

All keys below are values in OPFS-backed memory stores. Durable run authority
uses a dedicated one-key registry store plus one independently bounded store per
execution; it never consumes the owner/model `memory/master` key budget.
`journalTarget` can still point terminal journal projection at master,
named-agent, background-agent, or canonical HTTP(S) site-agent memory. At boot,
legacy authority is copied to the matching dedicated store, read back, and only
then version-CAS-deleted from master. Interrupted migration remains dual-readable
and idempotent; owner keys are never selected or evicted.

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
run compaction/eviction, and requires explicit clearing. There is no arbitrary
file-count ceiling: each store remains byte-bounded at 8 MiB, each value at
256 KiB, and the full OPFS tree at 64 MiB. Per-execution isolation prevents
retained authority for unrelated runs from crowding owner memory
(`extension/lib/durable-runs.js:29-37`; `extension/lib/memory.js`).

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

## Accepted seven-shot loaded-extension proof

The exact `dd41258f` source was freshly reconstructed as tree `80ca97f0`, built,
and loaded as a 103-file MV3 extension. One direct Chromium launch submitted one
prompt once, creating one task, execution, and thread. There were zero
retries/relaunches/resumes. Navigation, native owner controls, authoritative
thread/sidebar replacement, terminal projection, retained logs, and hard-reload
recovery were driven in the real UI. The independent review directly inspected
all seven 1600×1200 PNGs, paired raw-CDP records, the contact sheet, DOM and
accessibility snapshots, runtime state, and integrity bindings.

The proof uses the actual product UI: the Tasks sidebar's native thread row and
its standard click/keyboard behavior, the durable run registry/status card, and
the visible retained-log viewer. There is no `#tasks` route and no requirement
for a visible numeric `progressCount`; revision/progress counts are raw registry
evidence while visible progression is shown by genuine tool lifecycle cards,
run status, owner controls, and retained logs.

1. **`01-task-start.png`** — the submitted prompt, native Tasks row, and run
   registry show the sole execution starting/running with Cancel and View logs.
2. **`02-task-running-progress.png`** — the same execution remains running while
   a genuine successful `memory_set` tool card and result are visible; raw state
   advances to revision 4 / progress count 2.
3. **`03-navigate-away.png`** — Settings and its provider/model controls are
   fully rendered while the same execution remains nonterminal in service-worker
   authority.
4. **`04-task-panel-restored-nonterminal.png`** — returning through the native
   Tasks sidebar restores the same owner thread and running registry card (same
   execution ID, revision 5 / progress count 2) without a duplicate execution.
5. **`05-task-panel-progress-logs.png`** — native View logs exposes visible
   retained accepted/tool lifecycle rows while the same run continues (revision
   7 / progress count 4).
6. **`06-terminal-result-logs.png`** — the same execution reaches terminal
   revision 12 / progress count 6; one assistant result, one registry record,
   and complete visible accepted/tool-call/tool-result/terminal logs remain.
7. **`07-reload-persistence.png`** — after a hard reload, the same stable native
   Tasks row/title, thread, terminal execution/result/registry, and retained logs
   are visible. A 1000 ms plus two-frame interaction barrier observed document
   animations settle from six to zero before the native View logs click; the
   log viewer then scrolled `0 → 527`. No spinner, duplicate, or new ID appears.

Exact screenshot SHA-256 digests, in order:

- `01-task-start.png`: `5bdcdeade3e9d1f6bae8cf377636cc25299f8f74d436eb153e725475a9df704f`
- `02-task-running-progress.png`: `be2e179cd8980bcb9e1e9b136bb8320c92eae51ca1e6abfa9e07aa12d94022f9`
- `03-navigate-away.png`: `069c8c1e7fc8e93eff85a19af8fbe08b6da79fb1d375e71f89379294a19e750e`
- `04-task-panel-restored-nonterminal.png`: `957adb9e57b7d024f7cf3b394b57b9c7d6e926d80137037759f6aaa81e5884dd`
- `05-task-panel-progress-logs.png`: `cf292c8dab6cb42573f927c90892ba6f6bd6171529fd393f7a1c71919b3199c1`
- `06-terminal-result-logs.png`: `15b57e8ddaece425fdcb19546df8808c4f8bdaf31c2294370268eaa035e77900`
- `07-reload-persistence.png`: `0bea8196cf65ab7deea0c42696e2b4da535b421a279fde7e8b36b5a5f275f5f0`

The journey recorded zero browser exceptions, crashes, or websocket errors.
One known nonfatal packaged Settings request for `CHANGELOG.md` returned
`net::ERR_FILE_NOT_FOUND`; it did not affect that historical journey. The later
local task-view successor makes the clean-archive production build materialize
and verify the ignored generated package copy; that correction still requires
its own loaded-MV3 review and does not rewrite this evidence. The independent
verdict is `PASS_FOR_INTEGRATION`, scoped to this exact Durable source and evidence.
