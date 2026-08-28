// @ts-nocheck
// The run log as a WAL — CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01.
//
// The design's sharpest edge is byte-offset reading: a tail window begins
// mid-record, and getting the boundary wrong silently corrupts or drops the
// oldest row on every page. The measurement probe parsed 980 of 1,000 rows for
// exactly that reason, so it is asserted directly and deliberately here.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  appendRecords,
  encodeRecords,
  parseRecords,
  readAll,
  readRecent,
  rewrite,
} from "../extension/lib/run-log-wal.js";

// ---- an in-memory FileSystemFileHandle good enough for the WAL contract ----
function fakeFile() {
  let bytes = new Uint8Array(0);
  return {
    _dump: () => bytes,
    async getFile() {
      const snapshot = bytes;
      return {
        size: snapshot.length,
        async arrayBuffer() { return snapshot.buffer.slice(snapshot.byteOffset, snapshot.byteOffset + snapshot.length); },
        slice(a, b) {
          const sub = snapshot.subarray(a, b);
          return { async arrayBuffer() { return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.length); } };
        },
      };
    },
    async createWritable({ keepExistingData = false } = {}) {
      let pos = 0;
      let buf = keepExistingData ? bytes.slice() : new Uint8Array(0);
      return {
        async seek(p) { pos = p; },
        async write(chunk) {
          const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          const end = Math.max(buf.length, pos + incoming.length);
          const next = new Uint8Array(end);
          next.set(buf, 0);
          next.set(incoming, pos);
          buf = next;
          pos += incoming.length;
        },
        async close() { bytes = buf; },
      };
    },
  };
}

const rec = (i, over = {}) => ({ i, type: i % 2 ? "tool-result" : "tool-call", tool: "list_tabs", at: 1000 + i, ...over });

Deno.test("wal: append then read round-trips every record in order", async () => {
  const fh = fakeFile();
  await appendRecords(fh, [rec(0), rec(1), rec(2)]);
  const all = await readAll(fh);
  assertEquals(all.length, 3);
  assertEquals(all.map((r) => r.i), [0, 1, 2]);
});

Deno.test("wal: appends accumulate — the log is append-only", async () => {
  const fh = fakeFile();
  await appendRecords(fh, [rec(0)]);
  await appendRecords(fh, [rec(1), rec(2)]);
  await appendRecords(fh, [rec(3)]);
  assertEquals((await readAll(fh)).map((r) => r.i), [0, 1, 2, 3]);
});

Deno.test("wal: an empty append is a no-op and never truncates", async () => {
  const fh = fakeFile();
  await appendRecords(fh, [rec(0)]);
  await appendRecords(fh, []);
  await appendRecords(fh, null);
  assertEquals((await readAll(fh)).length, 1);
});

// ── the partial-head boundary — the edge that bit the probe ────────────────
Deno.test("wal PROPERTY: a window starting mid-record drops the partial head, never corrupts it", async () => {
  const fh = fakeFile();
  const records = Array.from({ length: 50 }, (_, i) => rec(i));
  await appendRecords(fh, records);
  const bytes = fh._dump();

  // Slice deliberately mid-record: one byte into the second record.
  const firstLen = encodeRecords([records[0]]).length;
  const cut = firstLen + 5;
  const parsed = parseRecords(bytes.subarray(cut), { baseOffset: cut });
  assertEquals(parsed[0].record.i, 2, "the first COMPLETE record after the cut");
  for (const e of parsed) assert(typeof e.record.i === "number", "no corrupt record survives");
  assertEquals(parsed.length, 48);
  // OFFSETS are the discriminator. Skipping the partial head must be
  // DELIBERATE, not incidentally achieved by the fragment failing to parse —
  // so assert the first kept record's offset is exactly where record 2 starts
  // in the file. A parser that did not skip would still drop the fragment (it
  // is not valid JSON) but would report a different offset, and the offset is
  // the pagination cursor.
  const offsetOfRecord2 = encodeRecords(records.slice(0, 2)).length;
  assertEquals(parsed[0].start, offsetOfRecord2, "the cursor must point at a real record boundary");
});

Deno.test("wal PROPERTY: the boundary skip is what drops a partial head, not luck", () => {
  // Worth being precise about, because it nearly is luck: a suffix of a JSON
  // OBJECT is never itself valid JSON (the braces do not balance), so for real
  // records the newline loop would discard a fragment anyway via JSON.parse
  // failing. The explicit skip-to-first-newline is what makes that a guarantee
  // rather than a happy accident — and this case proves it, because a suffix of
  // a JSON *number* IS valid JSON and would otherwise be admitted as a record.
  const enc = new TextEncoder();
  const bytes = enc.encode(`1234567890\n${JSON.stringify(rec(2))}\n`);
  const cut = 3; // leaves "4567890" — valid JSON on its own
  const parsed = parseRecords(bytes.subarray(cut), { baseOffset: cut });
  assertEquals(parsed.length, 1, "only the record after the newline survives");
  assertEquals(parsed[0].record.i, 2);
  assert(!parsed.some((e) => e.record === 4567890), "a valid-JSON partial head must NOT be admitted");
});

Deno.test("wal PROPERTY: baseOffset 0 keeps the very first record", async () => {
  const fh = fakeFile();
  await appendRecords(fh, [rec(0), rec(1)]);
  const parsed = parseRecords(fh._dump(), { baseOffset: 0 });
  assertEquals(parsed.map((e) => e.record.i), [0, 1], "nothing is dropped when the window starts at byte 0");
});

Deno.test("wal PROPERTY: a torn final write is discarded, and the rest survives", async () => {
  const fh = fakeFile();
  await appendRecords(fh, [rec(0), rec(1), rec(2)]);
  // Simulate a crash mid-append. The torn tail is deliberately VALID JSON with
  // no trailing newline: a parser that only rejects unparseable tails would
  // admit this one, so this is what actually discriminates a correct
  // implementation from an incidentally-correct one.
  const torn = new TextEncoder().encode('{"i":3,"type":"tool-call"}');
  const full = fh._dump();
  const merged = new Uint8Array(full.length + torn.length);
  merged.set(full, 0);
  merged.set(torn, full.length);
  const parsed = parseRecords(merged, { baseOffset: 0 });
  assertEquals(parsed.map((e) => e.record.i), [0, 1, 2], "the complete records survive; the torn one is dropped");
});

Deno.test("wal: a single corrupt line does not lose the rest of the log", async () => {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(rec(0))}\nthis is not json\n${JSON.stringify(rec(2))}\n`,
  );
  const parsed = parseRecords(bytes, { baseOffset: 0 });
  assertEquals(parsed.map((e) => e.record.i), [0, 2]);
});

Deno.test("wal: multi-byte characters survive a windowed read", async () => {
  // Byte-offset slicing must never split a UTF-8 sequence. Newlines are
  // single-byte and cannot appear inside a continuation, which is the reason
  // the parser cuts only at newline boundaries.
  const fh = fakeFile();
  const records = Array.from({ length: 40 }, (_, i) => rec(i, { note: "日本語のテキスト — émoji 🌍 " + i }));
  await appendRecords(fh, records);
  const page = await readRecent(fh, { limit: 10, maxBytes: 1024 });
  assertEquals(page.records.length, 10);
  for (const r of page.records) assert(r.note.includes("日本語"), "text is intact across the window edge");
  assertEquals(page.records.at(-1).i, 39);
});

// ── paging ────────────────────────────────────────────────────────────────
Deno.test("wal: readRecent returns the NEWEST records up to the limit", async () => {
  const fh = fakeFile();
  await appendRecords(fh, Array.from({ length: 100 }, (_, i) => rec(i)));
  const page = await readRecent(fh, { limit: 10 });
  assertEquals(page.records.map((r) => r.i), [90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  assertEquals(page.truncated, true, "older history exists before this page");
  assert(page.nextBefore > 0);
});

Deno.test("wal: nextBefore pages backwards through the whole log without gaps or repeats", async () => {
  const fh = fakeFile();
  const total = 95;
  await appendRecords(fh, Array.from({ length: total }, (_, i) => rec(i)));
  const seen = [];
  let before = null;
  for (let guard = 0; guard < 50; guard++) {
    const page = await readRecent(fh, { limit: 10, before });
    if (page.records.length === 0) break;
    seen.unshift(...page.records.map((r) => r.i));
    if (page.exhausted) break;
    before = page.nextBefore;
  }
  assertEquals(seen.length, total, "every record seen exactly once");
  assertEquals(seen, Array.from({ length: total }, (_, i) => i), "in order, no gaps, no repeats");
});

Deno.test("wal: a window too small for the limit widens instead of under-returning", async () => {
  const fh = fakeFile();
  await appendRecords(fh, Array.from({ length: 200 }, (_, i) => rec(i)));
  // 64 bytes cannot hold 50 records; readRecent must widen the window.
  const page = await readRecent(fh, { limit: 50, maxBytes: 64 });
  assertEquals(page.records.length, 50);
  assertEquals(page.records.at(-1).i, 199);
});

Deno.test("wal: reading an empty log is honest, not an error", async () => {
  const fh = fakeFile();
  const page = await readRecent(fh, { limit: 10 });
  assertEquals(page.records, []);
  assertEquals(page.exhausted, true);
  assertEquals(page.truncated, false);
  assertEquals(await readAll(fh), []);
});

Deno.test("wal: a log shorter than the limit is exhausted, not truncated", async () => {
  const fh = fakeFile();
  await appendRecords(fh, [rec(0), rec(1)]);
  const page = await readRecent(fh, { limit: 10 });
  assertEquals(page.records.length, 2);
  assertEquals(page.exhausted, true);
  assertEquals(page.truncated, false, "there is no older history to flag");
});

Deno.test("wal: rewrite replaces the log wholesale (migration/retention only)", async () => {
  const fh = fakeFile();
  await appendRecords(fh, [rec(0), rec(1), rec(2)]);
  await rewrite(fh, [rec(7), rec(8)]);
  assertEquals((await readAll(fh)).map((r) => r.i), [7, 8]);
});

Deno.test("wal: encodeRecords is newline-delimited JSON, one record per line", () => {
  const bytes = encodeRecords([rec(0), rec(1)]);
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  assertEquals(lines.at(-1), "", "the log always ends with a newline");
  assertEquals(lines.filter(Boolean).length, 2);
  for (const l of lines.filter(Boolean)) JSON.parse(l); // must each parse alone
});
