// run-log-wal.js — the per-execution run log as a write-ahead log
// (CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01).
//
// Owner: "I don't want 1000 files. why not a WAL?"
//
// A run log is an append-only event log, and it was stored as one key-value
// record per row. Measured on the real extension service worker, that cost
// 171 s to write 1,000 rows (the per-append index rewrite is O(n²)) and 348 ms
// to read them back even after the reads were made concurrent. As one
// append-only JSONL file: **1 ms to write 1,000 rows batched, 0.4 ms to read a
// 64 KiB tail.** See docs/THREAD-LOADING-REDESIGN.md §3 and
// `scripts/opfs-wal-probe.ts` for the measurements.
//
// WHY THIS SHAPE
//   * The log IS the index. There is no index file and no digest set, so the
//     O(n²) per-append index rewrite simply stops existing.
//   * Append does not copy the file. Measured flat (~0.6 ms) at 1 / 250 / 500 /
//     750 / 1,000 rows, which is what makes `createWritable` viable here — the
//     fast `createSyncAccessHandle` API is NOT available in an extension
//     service worker.
//   * A torn write is detectable. A crash mid-append leaves an unterminated
//     final line, which the parser discards. The old form could leave an index
//     entry naming a row file that was never written.
//
// SINGLE WRITER. `createWritable` does not lock the file. The durable-run
// registry's write lock currently makes the service worker the only writer, and
// that must stay true. The owner's observation (2026-08-28) is the durable fix:
// with the per-agent actor/worker model, an agent's writes can be serialised
// through its own single worker instance, making single-writer structural
// rather than conventional — and shared workers also have
// `createSyncAccessHandle`, which the service worker does not. Recorded as the
// follow-on in docs/THREAD-LOADING-REDESIGN.md; this module is written so that
// move changes only where `appendRecords` is called from, not its contract.

const NL = 10; // "\n" as a byte — records are newline-delimited UTF-8 JSON.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Default tail window. 64 KiB comfortably holds several hundred rows; a read
 *  that needs more rows than the window yields simply widens it. */
export const WAL_DEFAULT_TAIL_BYTES = 64 * 1024;
export const WAL_MAX_TAIL_BYTES = 4 * 1024 * 1024;

/** Byte access that works on a real OPFS File and on the in-memory doubles the
 *  test suite uses (28 files carry their own, and they expose `text()` rather
 *  than `arrayBuffer()`/`slice()`). Production always takes the first branch;
 *  the text branch exists so this module is testable against those doubles
 *  without rewriting all of them. */
async function fileBytes(file) {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return encoder.encode(await file.text());
}

async function fileRange(file, start, end) {
  if (typeof file.slice === "function") {
    const part = file.slice(start, end);
    if (typeof part?.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer());
  }
  return (await fileBytes(file)).subarray(start, end);
}

/** Serialise records to the exact bytes the log stores. */
export function encodeRecords(records) {
  let out = "";
  for (const record of records) out += `${JSON.stringify(record)}\n`;
  return encoder.encode(out);
}

/**
 * Parse a byte range into records, each with its ABSOLUTE byte offset.
 *
 * Offsets are returned rather than derived later because the byte offset is the
 * pagination cursor, and re-deriving it by re-encoding would be both slower and
 * a second source of truth.
 *
 * `baseOffset` is where `bytes` starts in the file. When it is not 0 the range
 * almost certainly begins mid-record, so **everything before the first newline
 * is discarded** — that partial head is the sharpest edge in this design. (The
 * measurement probe parsed 980 of 1,000 rows for exactly this reason before it
 * was handled.) A trailing unterminated line is discarded too: it is either a
 * torn write or a record the window cut off.
 */
export function parseRecords(bytes, { baseOffset = 0 } = {}) {
  const out = [];
  if (!bytes || bytes.length === 0) return out;
  let cursor = 0;
  if (baseOffset !== 0) {
    const firstNl = bytes.indexOf(NL);
    if (firstNl < 0) return out; // no complete record in this window
    cursor = firstNl + 1;
  }
  while (cursor < bytes.length) {
    const nl = bytes.indexOf(NL, cursor);
    if (nl < 0) break; // unterminated trailing line — torn write or cut window
    const lineBytes = bytes.subarray(cursor, nl);
    if (lineBytes.length > 0) {
      // Decoding only between newline boundaries is what makes byte-offset
      // slicing safe: a newline is single-byte and can never appear inside a
      // UTF-8 continuation sequence, so no multi-byte character is ever split.
      try {
        out.push({ record: JSON.parse(decoder.decode(lineBytes)), start: baseOffset + cursor, end: baseOffset + nl + 1 });
      } catch {
        // A single corrupt line must not lose the rest of the log.
      }
    }
    cursor = nl + 1;
  }
  return out;
}

/** Append records. ONE open and ONE write regardless of how many records —
 *  that is what turns 1,000 appends from 171 s into 1 ms. */
export async function appendRecords(fileHandle, records) {
  if (!records?.length) return { appended: 0, bytes: 0, endOffset: (await fileHandle.getFile()).size };
  const bytes = encodeRecords(records);
  const size = (await fileHandle.getFile()).size;
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  try {
    if (typeof writable.seek === "function") {
      // The real path, and the one the measurements describe: seek to the end
      // and write only the new bytes. Verified flat in file size on a real
      // extension service worker (scripts/opfs-wal-probe.ts).
      await writable.seek(size);
      await writable.write(bytes);
    } else {
      // Fallback for a writable without `seek` — in practice the in-memory
      // OPFS doubles used across the test suite. It rewrites from byte 0, so
      // it is O(filesize) and would reintroduce exactly the cost this module
      // exists to remove. It is deliberately NOT silent about that: production
      // always has `seek`, and if this branch is ever hit there, appends have
      // quietly become quadratic again.
      const existing = size > 0 ? await fileBytes(await fileHandle.getFile()) : new Uint8Array(0);
      const merged = new Uint8Array(existing.length + bytes.length);
      merged.set(existing, 0);
      merged.set(bytes, existing.length);
      await writable.write(merged);
    }
  } finally {
    await writable.close();
  }
  return { appended: records.length, bytes: bytes.length, endOffset: size + bytes.length };
}

/**
 * Read the most recent `limit` records ending strictly before byte `before`,
 * widening the window until enough complete records are found or the file is
 * exhausted.
 *
 * Returns `nextBefore` — the byte offset of the first record returned — so the
 * caller pages backwards by passing it straight back.
 */
export async function readRecent(fileHandle, { limit = Infinity, before = null, maxBytes = WAL_DEFAULT_TAIL_BYTES } = {}) {
  const file = await fileHandle.getFile();
  const end = before == null ? file.size : Math.max(0, Math.min(before, file.size));
  if (end === 0) return { records: [], nextBefore: 0, exhausted: true, truncated: false };

  let window = Math.min(Math.max(maxBytes, 1024), WAL_MAX_TAIL_BYTES);
  let entries = [];
  let start = 0;
  for (;;) {
    start = Math.max(0, end - window);
    const buf = await fileRange(file, start, end);
    entries = parseRecords(buf, { baseOffset: start });
    const enough = Number.isFinite(limit) ? entries.length >= limit : start === 0;
    if (enough || start === 0 || window >= WAL_MAX_TAIL_BYTES) break;
    window = Math.min(window * 4, WAL_MAX_TAIL_BYTES);
  }

  const kept = Number.isFinite(limit) && entries.length > limit ? entries.slice(-limit) : entries;
  // Exhausted only if we read from byte 0 AND kept everything we parsed.
  const exhausted = start === 0 && kept.length === entries.length;
  const nextBefore = kept.length > 0 ? kept[0].start : 0;
  return {
    records: kept.map((e) => e.record),
    nextBefore,
    exhausted,
    truncated: !exhausted, // honest marker: older history exists before this page
  };
}

/** Read every record. Used by migration and by unbounded callers. */
export async function readAll(fileHandle) {
  const file = await fileHandle.getFile();
  if (file.size === 0) return [];
  const buf = await fileBytes(file);
  return parseRecords(buf, { baseOffset: 0 }).map((e) => e.record);
}

/** Replace the log's entire contents. Migration and retention rewrites only —
 *  never the append path. */
export async function rewrite(fileHandle, records) {
  const bytes = encodeRecords(records);
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
  return { bytes: bytes.length, records: records.length };
}
