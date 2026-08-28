# Task loading — storage and view re-architecture

**Status:** DESIGN, awaiting owner review. Nothing here is implemented.
**Task:** `CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01`
**Author:** claude-opus-5 session, 2026-08-28
**Measurements:** `scripts/thread-open-trace.ts` (task-open timing) and
`scripts/opfs-wal-probe.ts` (the OPFS storage facts) — both committed and reproducible

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

## 3. The design — a write-ahead log

**Owner, 2026-08-28: "I don't want 1000 files. why not a WAL?"**

The first draft of this section proposed chunking rows into 100-row files. That
was wrong — it optimised *within* the existing key-value store instead of asking
whether one KV record per row is the right primitive for what is literally an
append-only event log. A WAL is the right shape, and the measurements below say
it is not a modest improvement but roughly three orders of magnitude.

### 3.1 What was measured (extension service worker, real OPFS)

| operation | result |
|---|---|
| `createSyncAccessHandle` in the SW | **unavailable** — only `createWritable` |
| append, file at 1 / 250 / 500 / 750 / 1,000 rows | **1.8 / 0.7 / 0.5 / 0.5 / 0.6 ms** |
| 1,000 rows appended in ONE open | **1 ms** |
| tail read, 64 KiB `Blob.slice` | **0.4 ms** |
| whole-file read, 1,000 rows | **0.2 ms** |

Two facts decide the design:

- **The fast synchronous API is not available where logging happens.** The
  extension service worker has no `createSyncAccessHandle`. Everything below
  uses `createWritable` + `Blob.slice`, which is enough.
- **Append does not copy the file.** The cost is flat as the file grows, which
  was the main risk in using `createWritable({keepExistingData:true})`. Chrome
  does not stage a whole-file copy per open here.

Against today's numbers — 171 s to write 1,000 rows, 348 ms to read them after
stages 1–2 — a WAL is ~**1000×** on reads and, batched, ~**170,000×** on writes.
The chunking design would have been perhaps 10×. This is not a close call.

### 3.2 The format

One append-only JSONL file per execution:

```
runs/<executionId>.log      one JSON record per line, append-only
```

Each line is the record that is stored today, plus its `idempotencyKey` and
`at`. There is **no index file and no digest set** — the log *is* the index.
Everything the current design maintains separately (`run-log-idx:`, the
per-append index rewrite that costs O(n²), the `recentDigests` set the chunking
draft invented) simply stops existing.

- **Append**: open writable with `keepExistingData`, seek to size, write
  `JSON.stringify(record) + "\n"`, close. ~0.6 ms, flat in file size.
- **Batched append**: buffer records arriving in the same tick and write once —
  1,000 rows in 1 ms. This is what makes a busy run cheap.
- **Read a page**: `getFile()`, then `slice(size - N, size).text()`, split on
  newlines, parse. 0.4 ms for 64 KiB.
- **Page back**: slice an earlier byte range. The cursor becomes a byte offset,
  which is both smaller and cheaper than today's row-key cursor.

**The partial first line is real and must be handled.** The 64 KiB tail read
above parsed 980 of 1,000 rows because the slice began mid-record. A tail read
must discard everything before the first newline in the slice (unless the slice
starts at byte 0), and widen the slice if it did not yield enough rows.

### 3.3 Why this is *safer* than what exists, not just faster

- **Torn writes become detectable.** A crash mid-append leaves an unterminated
  final line, which is discarded on read. Today a crash can leave an index
  entry naming a row file that was never written — the `complete === false`
  stale-index path exists precisely to paper over that.
- **Idempotency gets simpler, not harder.** The chunking draft weakened it to a
  bounded digest set and I flagged that as the riskiest part of the change. With
  a WAL the concern dissolves: the `idempotencyKey` is a field on every record,
  a tail scan is 0.4 ms, and the active execution keeps its recent keys in
  memory anyway. Duplicate detection stops being a storage problem.
- **One file per execution, not one per row.** Directly what the owner asked
  for, and it removes the per-row file-handle cost that stages 1–2 could only
  hide behind concurrency.

### 3.4 Streaming the view

Unchanged from the original design, and now trivial: the first page is a 64 KiB
tail read of the most recent execution — sub-millisecond — so `thread.get` can
return the visible screen immediately and stream the rest. The existing honest
markers (`truncatedExecutions`, `truncatedLogs`, `logFailed`, `viewDegraded`)
are carried per page.

## 4. Migration

Existing profiles hold `run-log:<exec>:<digest>` KV rows. Per execution, lazily,
on first read:

1. Read the rows through the current path.
2. Write them into `runs/<executionId>.log` in `at` order.
3. Read the log back and verify the record count before removing the KV rows.
4. A crash mid-migration leaves both forms; the reader prefers the log.

Same shape as `migrateSiteAssetsToLibrary` — write, verify, then delete — and
the same reason: losing run history is worse than migrating slowly. No
boot-time sweep; a thread nobody opens costs nothing.

## 5. What could go wrong

- **The partial-line boundary** (§3.2). Get it wrong and the oldest visible row
  in a page is corrupt or missing. Must be covered by a test that slices
  deliberately mid-record.
- **Concurrent writers.** `createWritable` does not lock the file. Today the
  registry mutex makes the SW the single writer, and that must remain true.
  **The owner's observation (2026-08-28) is the durable answer:** with the
  per-agent actor/worker model already shipped, an agent's writes can be
  serialised through its own single worker instance, which makes single-writer
  *structural* rather than conventional. It also unlocks
  `createSyncAccessHandle`, which shared workers have and the service worker
  does not — so the same move that removes the correctness caveat also removes
  the one API limitation this design had to work around. Deliberately NOT done
  in the same change: it moves where logging runs, which is a bigger blast
  radius than changing how it is stored. The module is written so that move
  changes only where `appendRecords` is called from, not its contract.
- **Retention and growth.** Today's row cap is implicit in the index; a log
  grows without bound. Needs an explicit size bound with either segmentation or
  offline rewrite. This is the one place the design adds a concern rather than
  removing one.
- **Quota failures mid-append** leave a partial final line — which the reader
  already discards. That is the WAL working as intended, but it should be
  asserted rather than assumed.
- **Encoding.** Records must be written as UTF-8 bytes and sliced on byte
  offsets; a multi-byte character straddling a slice boundary is the same class
  of bug as the partial line.

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

## 5b. Measured result of stage 3 — the WAL (2026-08-28)

Landed and wired. Same harness, median of three:

| rows | baseline | after 1+2 | **after the WAL** |
|---|---|---|---|
| open 10 | 15 ms | 9 ms | **9 ms** |
| open 250 | 213 ms | 81 ms | **40 ms** |
| open 1,000 | 918 ms | 348 ms | **146 ms** |
| write 10 | 140 ms | — | **70 ms** |
| write 250 | 11,183 ms | — | **1,994 ms** |
| write 1,000 | 171,375 ms | — | **14,113 ms** |

**Open: 6.3x faster than baseline** (918 → 146 ms), 2.4x of that from the WAL
itself. **Write: 12x faster** (171 s → 14 s for 1,000 rows).

**The write number is well short of the probe's 1 ms, and the reason is
important:** `appendLog` is called one row at a time, so each row still costs a
file open. The probe's 1 ms was 1,000 rows written in ONE open. Realising that
means buffering appends within a tick and flushing once — a change to *when* we
write, not to how it is stored, and the module already supports it
(`appendRecords` takes an array). That is the next win and it is cheap.

## 6. Staging

Each stage is independently shippable and leaves the product green.

| # | Change | Expected effect | Risk |
|---|---|---|---|
| 1 | Concurrent execution reads + concurrent row reads within a page (§3.2, no storage change) | **DONE** — 918 → 425 ms at 1,000 rows | Low |
| 2 | Split the global mutex into a read/write lock: readers share, writers exclusive | **DONE** — 425 → 348 ms | Medium |
| 3 | **WAL: one append-only file per execution** + lazy migration (§3, §4) | **DONE** — open 348 → 146 ms; write 171 s → 14 s | **High** |
| 4 | Streamed first page (§3.4) | First paint independent of history | Low (trivial once 3 lands) |

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
