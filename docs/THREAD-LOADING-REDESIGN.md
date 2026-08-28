# Task loading — storage and view re-architecture

**Status:** DESIGN, awaiting owner review. Nothing here is implemented.
**Task:** `CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01`
**Author:** claude-opus-5 session, 2026-08-28
**Measurements:** `scripts/thread-open-trace.ts` (committed, reproducible)

Owner: *"When I click on a task it takes way too long to load and we need to
redesign how the data store works to display the content… I think we need a
complete re-architecture of task loading and the view creation."*

---

## 1. What was measured

A real profile, seeded through the production API (`durableRuns.start` /
`appendLog`), then timing the exact `thread.get` route the UI calls. No provider
and no API key: task open is storage and projection, not inference.

| runs × logs | log rows | write (seed) | **task open** | messages |
|---|---|---|---|---|
| 1 × 10 | 10 | 140 ms | **13 ms** | 12 |
| 5 × 50 | 250 | 11.2 s | **223 ms** | 256 |
| 10 × 100 | 1,000 | 173 s | **~960 ms** | 1,011 |

**Reads are linear at ~0.95 ms per log row.** The product's own bound is 25
executions × 250 rows = 6,250 rows, which extrapolates to **~6 s to open a
task**. That is the reported symptom.

**Writes are superlinear and worse.** Cost per row: 14 ms → 45 ms → **173 ms**.
Writing 1,000 rows takes nearly three minutes. Seeding to the product's own
documented bound never finished. This is not only a seeding artefact — it is the
live logging path, so **a long task gets progressively slower as it runs**, and
because writes hold a global lock they also block reads.

The per-stage spans (`thread.get:read`, `thread.get:view`, `thread-view:logs:*`,
`thread-view:project`) are recorded by `cap-perf.js` and work correctly. An
earlier draft of this document said they "reported 0 ms in the production
build" and treated that as a finding — it was a bug in the measuring harness,
which read a field named `total` where `perfSummary` reports `totalMs`. The
product instrumentation needed no fixing; the tool did. Corrected, and recorded
here because a design that argues from measurements has to be honest about the
measurements it got wrong.

## 2. Why — four causes, all confirmed in source

**(a) `appendLog` rewrites the entire per-execution row index on every append.**
`extension/lib/durable-runs.js`: each append reads `run-log-idx:<exec>`, pushes
one entry, and writes the whole array back. Writing *n* rows therefore performs
O(n²) index-entry writes. This is the superlinear write cost.

**(b) One global mutex serialises all durable-run I/O.** `locked()` chains every
operation onto a single promise for the whole registry — reads included. Two
independent executions can never be read concurrently, and a live run's logging
blocks a task open happening at the same moment.

**(c) Each log row is its own OPFS file.** Reading a 250-row page performs 250
sequential `store.get` calls, each opening a file, inside the mutex.

**(d) Three serialisations stack on open.** `buildThreadRunView` awaits per
execution → `listLogs` takes the global mutex → `listLogs` awaits per row. At the
bound that is 25 × (1 + 1 + 250) ≈ **6,300 sequential file reads** before
`thread.get` returns. And it is all-or-nothing: the UI receives nothing until
every execution has been assembled, so there is no partial paint.

**The root cause is granularity.** One file per log row is the wrong unit for
both reading and writing. Everything else follows from it.

## 3. The design

Three changes, independently landable, in value order.

### 3.1 Chunked log pages (the storage change)

Replace one-file-per-row with **append-only chunk files of up to `CHUNK_ROWS`
(100) rows**:

```
run-log-chunk:<executionId>:<seq>   → { schemaVersion, retentionPolicyVersion,
                                        executionId, seq, rows: [ …row… ] }
run-log-head:<executionId>          → { schemaVersion, executionId, chunkCount,
                                        rowCount, openSeq, openRows,
                                        firstAt, lastAt }
```

- **Append** writes to the open chunk (`openSeq`) and updates the small head
  record. Cost per append is O(chunk size), bounded and constant — not O(n).
  When a chunk reaches `CHUNK_ROWS` it is sealed and `openSeq` increments; a
  sealed chunk is immutable, which is what makes concurrent reads safe.
- **Read a page** of the most recent 250 rows touches `ceil(250/100) + 1 = 4`
  files instead of 251.
- **Ordering** stays exactly as today: rows carry `at`, sorted by `at` then by
  `idempotencyKey`/`type`. Chunks are ordered by `seq`, and `seq` order agrees
  with `at` order because appends are serialised per execution.
- **Idempotency is preserved.** Today the row key embeds the SHA-256 of the
  idempotency key, so a repeat append is a no-op via `store.has`. In the chunked
  form the head record carries a bounded `recentDigests` set (the last
  `CHUNK_ROWS × 2` digests) and each sealed chunk carries the digests it
  contains, so a duplicate append is still detected without reading every chunk.
  *This is the single most delicate part of the change* — see §5.
- **Large entries** keep the existing `payloadRef` overflow: a row whose
  serialised form exceeds `RESUME_CHUNK_CHARS` still spills to its own payload
  file and the chunk stores the reference. Chunks therefore stay bounded.

**Cursor pagination survives.** `listLogs({limit, before})` currently takes a row
*key* as the cursor. The chunked form takes `{seq, offset}` — but to avoid a
breaking change the cursor stays an opaque string the caller round-trips, which
it already is; only its internal format changes.

### 3.2 Split the lock, and read concurrently

- **Readers share the lock; writers stay exclusive.** (Shipped this way rather
  than fully lock-free: `listLogs`'s fallback path REBUILDS and persists the row
  index, so it is not a pure read. The shared path serves the indexed fast case,
  and a read that would have to rebuild asks to be retried under the exclusive
  lock instead of writing underneath a concurrent writer.) Once chunks land,
  sealed chunks are immutable and the head record is written atomically, so the
  fast path can widen further.
- **Writes could later take a per-execution lock** rather than a registry-wide
  one. Not needed yet: with readers sharing, writers no longer block opens for
  the common case.
- **`buildThreadRunView` reads executions concurrently** with a bounded pool
  (8 at a time — enough to hide latency, bounded so a 25-execution thread does
  not open 25 file handles at once).

Alone, (3.2) turns the ~6,300 sequential reads into ~100 concurrent ones. It is
the cheapest large win and does not require the storage change — **it is the
first thing to land**.

### 3.3 Stream the view instead of assembling it

`thread.get` currently returns only when every execution is projected. Instead:

1. Return the **most recent execution's last page immediately** — that is what
   the owner is looking at when the thread opens.
2. Stream the remainder over the existing durable-run port as further pages,
   oldest-last, so the transcript fills in behind the fold.
3. The existing honest markers (`truncatedExecutions`, `truncatedLogs`,
   `logFailed`, `viewDegraded`) are carried per page rather than for the whole
   view, so a partially-loaded thread still says what it does not have.

Target: **first paint under 150 ms regardless of history size**, because it is
then a function of one page, not of the thread.

## 4. Migration

Existing profiles hold row-per-file data. The migration must not lose it and
must not block the first open.

- On first read of an execution that has `run-log:` rows and no
  `run-log-head:`, read them with the current path, **write them into chunks**,
  then serve from the chunks. This is the same shape as the existing
  legacy-index fallback in `listLogs`, so the pattern is already established.
- The old rows are removed only after the chunked form has been read back and
  verified, mirroring `migrateSiteAssetsToLibrary` — body before index, verify,
  then delete. A crash mid-migration leaves both forms, and the reader prefers
  chunks.
- Migration is per execution and lazy. There is no boot-time sweep: a thread the
  owner never opens costs nothing.

## 5. What could go wrong

Recorded because these are the parts a review should attack hardest.

- **Idempotency regression.** Today's guarantee comes from the row key itself,
  which is content-addressed by the idempotency digest. Moving to a bounded
  `recentDigests` set weakens it for a duplicate arriving after more than
  `CHUNK_ROWS × 2` intervening rows. Whether that can happen depends on the
  retry paths (`resumeAfterInterruption`, `activateResume`). **This must be
  proven before the storage change lands**, and if it cannot be, the digest set
  becomes a per-execution index of digests only — still one small file, still
  O(1) to append to, without the bound.
- **Partial chunk visibility.** A reader that takes the head record and then
  reads chunks could see a chunk sealed after its head read. Harmless (it just
  misses the newest rows, which the live stream provides) but it must be
  *deliberate*, and the head's `rowCount` must be treated as a floor, not a
  count.
- **Retention policy.** Every row currently carries `retentionPolicyVersion` and
  a mismatch throws. Chunks must carry it at the chunk level and the check must
  stay — this is what stops a future policy change silently serving stale rows.
- **Storage-quota behaviour under a different write shape.** `durable-quota.js`
  translates a native `QuotaExceededError` into the stable route response; it
  does not do byte accounting, so there is no ledger to re-derive. What changes
  is *when* a quota failure can occur: today an append writes one small row file
  plus a growing index; chunked, it rewrites one chunk of up to 100 rows. The
  failure is therefore larger-grained, and a mid-chunk quota failure must leave
  the sealed chunks and the head record consistent — a partially written chunk
  must never be named by the head.
- **Streaming and the terminal-marker reconciliation.** `buildThreadRunView`
  back-fills missing terminal markers via `commitTerminal` on the read path.
  With streaming, that reconciliation must happen once for the whole thread, not
  once per page.

## 5a. Measured result of stages 1 and 2 (2026-08-28)

Both landed. Task open, median of three, same harness:

| rows | before | after 1+2 | speedup |
|---|---|---|---|
| 10 | 15 ms | **8 ms** | 1.9x |
| 250 | 213 ms | **72 ms** | 3.0x |
| 1,000 | 918 ms | **348 ms** | 2.6x |

Extrapolated to the product's bound (6,250 rows): ~6 s → **~2.2 s**.

**My stage-1 prediction was wrong and should be recorded as such.** §6 said stage 1
alone would reach 150–250 ms at 1,000 rows; it reached 425 ms. The reason is
identifiable rather than mysterious: stage 1 made rows *within* a page concurrent,
but every `listLogs` call still queued on the one global mutex, so the bounded
fan-out across executions could not actually overlap. That is cause (b), which
stage 2 addresses — so the model was right about the causes and wrong about how
much of the win stage 1 could deliver on its own. Stage 2 then took 425 → 348 ms.

**The remaining cost is granularity, exactly as §2 predicted.** 1,000 rows is
still 1,000 OPFS file opens; making them concurrent bounds the latency but not
the syscall count. Stage 3 (chunking) is where the rest of the win is, and the
measurements now support that rather than merely asserting it.

Attribution after stages 1–2 is unchanged in shape: `thread-view:logs` still
dominates, `thread-view:project` is 5 ms and `thread.get:read` 6 ms — the
projection and the thread-record read are noise, as §8 said.

## 6. Staging

Each stage is independently shippable and leaves the product green.

| # | Change | Expected effect | Risk |
|---|---|---|---|
| 1 | Concurrent execution reads + concurrent row reads within a page (§3.2, no storage change) | **DONE** — 918 → 425 ms at 1,000 rows | Low |
| 2 | Split the global mutex into a read/write lock: readers share, writers exclusive | **DONE** — 425 → 348 ms | Medium |
| 3 | Chunked log pages + lazy migration (§3.1, §4) | Append O(1) amortised; page read 4 files not 251 | **High** |
| 4 | Streamed first page (§3.3) | First paint independent of history | Medium |

Stage 1 alone should take the 1,000-row case from ~960 ms to roughly 150–250 ms.
If it does not, the model above is wrong and stages 2–4 should be re-argued
before proceeding.

## 7. How this is verified

- `scripts/thread-open-trace.ts` is the harness and already runs. Every stage
  reports its matrix before and after, in the same table as §1.
- **Stage attribution comes from the product's own spans** (`thread.get:read`,
  `thread.get:view`, `thread-view:logs:*`, `thread-view:project`) via
  `observability.dumpTrace`. These work; the harness was reading the wrong field
  name and has been fixed.
- The existing suites are the correctness gate: `tests/thread-log-redesign.test.ts`
  (the projection, the reconciliation and the degraded-read paths),
  `tests/durable-runs.test.ts`, `tests/durable-task-restore.test.ts`,
  `tests/evidence-durable.test.ts`, `tests/artifacts-in-thread.test.ts`, the
  Chrome journeys, and `npm run test:opfs` for a real-browser OPFS check.
- Per the falsification rule, each stage shows its regression test failing
  against the unfixed code before the fix lands.

## 8. What this does not change

The projection itself (`projectThreadWithRunLogs`, `toolRowsFromRunLog`) is pure
and is very unlikely to be the bottleneck — it is in-memory array work over rows
that have already been read, against ~0.95 ms per row of measured I/O. The
`thread-view:project` span now reports, so stage 1 confirms this rather than
assuming it. The tool-card
rendering work (`CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01`) is orthogonal and can
proceed in parallel. The durable-run authority, its recovery semantics and the
outbox are untouched: this changes how rows are stored and read, not what a run
means.
