// @ts-nocheck — injected OPFS handles are deliberately minimal and faultable.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  readMasterJournalHead,
  readMasterJournalProjection,
  sealMasterJournalRecord,
  stageMasterJournalCutover,
  stageMasterJournalFrame,
  unsealMasterJournalRecord,
} from "../extension/lib/master-journal-wal.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
function missing(name) { return new DOMException(`${name} missing`, "NotFoundError"); }

class MemoryFile {
  constructor(name, faults) { this.name = name; this.faults = faults; this.bytes = new Uint8Array(); }
  async getFile() {
    const bytes = this.bytes.slice();
    return { size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } };
  }
  async createWritable() {
    let next = new Uint8Array();
    return {
      write: async (value) => {
        if (this.faults?.write === this.name) throw new Error(`injected write ${this.name}`);
        next = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
      },
      close: async () => {
        if (this.faults?.close === this.name) {
          this.bytes = next.slice(0, Math.max(1, Math.floor(next.byteLength / 2)));
          throw new Error(`injected close ${this.name}`);
        }
        this.bytes = next;
      },
      abort: async () => {},
    };
  }
}

class MemoryDir {
  constructor(name = "", faults = {}) { this.name = name; this.faults = faults; this.children = new Map(); }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw missing(name);
      this.children.set(name, new MemoryDir(name, this.faults));
    }
    return this.children.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw missing(name);
      this.children.set(name, new MemoryFile(name, this.faults));
    }
    return this.children.get(name);
  }
}

async function legacyFixture(faults = {}) {
  const master = new MemoryDir("master", faults);
  const legacy = JSON.stringify({ __v: 17, __value: [{ type: "old", id: 1 }] });
  (await master.getFileHandle("journal.json", { create: true })).bytes = encoder.encode(legacy);
  let generation = 17;
  return { master, legacy, allocateVersion: async () => ++generation };
}

Deno.test("master journal cutover stages and verifies whole live/archive rows before publishing one checked head", async () => {
  const { master, legacy, allocateVersion } = await legacyFixture();
  const journal = Array.from({ length: 501 }, (_, i) => ({ id: i, result: `whole-${i}-🚀` }));
  assertEquals(await readMasterJournalHead(master), null);
  await stageMasterJournalCutover(master, { journalExists: true, journal, archive: [{ id: "archived" }], allocateVersion });
  const projection = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projection.version, 18);
  assertEquals(projection.live.length, 500);
  assertEquals(projection.live[0], journal[1]);
  assertEquals(projection.archive, [{ id: "archived" }, journal[0]]);
  assertEquals(projection.exists, true);
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy, "raw legacy value is never rewritten by staging");
  await assertRejects(() => stageMasterJournalCutover(master, {
    journalExists: true, journal: [], archive: [], allocateVersion,
  }), Error, "already cut over");
});

Deno.test("cutover retains an unbounded legacy archive in bounded immutable segments", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const archived = Array.from({ length: 1_201 }, (_, id) => ({ id, text: `whole-archived-${id}-🚀` }));
  await stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: "live" }], archiveExists: true, archive: archived, allocateVersion,
  });
  const wal = await master.getDirectoryHandle("journal-wal");
  const segments = [...wal.children.entries()]
    .filter(([name]) => /^archive-\d+-\d+\.json$/.test(name))
    .map(([, file]) => file);
  assertEquals(segments.length, 3, "a 1,201-row legacy archive must not become one giant record");
  for (const segment of segments) {
    const record = await unsealMasterJournalRecord(segment.bytes, "archive");
    assertEquals(record.rows.length <= 500, true, "each immutable segment has at most 500 whole rows");
  }
  const projection = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projection.archive, archived, "no row is dropped or clipped by segmentation");
});

Deno.test("checked archive chain rejects changed tail, missing interior and re-sealed interior", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const archived = Array.from({ length: 1_201 }, (_, id) => ({ id }));
  const head = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [], archive: archived, allocateVersion,
  });
  const wal = await master.getDirectoryHandle("journal-wal");
  const tail = await wal.getFileHandle(head.archive);
  const originalTail = tail.bytes.slice();
  const newTail = await unsealMasterJournalRecord(tail.bytes, "archive");
  tail.bytes = encoder.encode(await sealMasterJournalRecord("archive", {
    ...newTail, rows: [{ id: "same-epoch-swapped-tail" }],
  }));
  await assertRejects(() => readMasterJournalProjection(master, { includeArchive: true }), Error, "chain hash mismatch");
  tail.bytes = originalTail;
  const middle = wal.children.get(`archive-${head.epoch}-1.json`);
  wal.children.delete(`archive-${head.epoch}-1.json`);
  await assertRejects(() => readMasterJournalProjection(master, { includeArchive: true }), Error, "segment archive-");
  wal.children.set(`archive-${head.epoch}-1.json`, middle);
  const originalMiddle = middle.bytes.slice();
  const prior = await unsealMasterJournalRecord(middle.bytes, "archive");
  middle.bytes = encoder.encode(await sealMasterJournalRecord("archive", {
    ...prior, rows: [{ id: "re-sealed-interior" }],
  }));
  await assertRejects(() => readMasterJournalProjection(master, { includeArchive: true }), Error, "chain hash mismatch");
  middle.bytes = originalMiddle;
  assertEquals((await readMasterJournalProjection(master, { includeArchive: true })).archive, archived);
});

Deno.test("master journal cutover preserves absent versus present-empty", async () => {
  const absent = await legacyFixture();
  await stageMasterJournalCutover(absent.master, { journalExists: false, journal: [], archive: [], allocateVersion: absent.allocateVersion });
  assertEquals((await readMasterJournalProjection(absent.master)).exists, false);
  const empty = await legacyFixture();
  await stageMasterJournalCutover(empty.master, { journalExists: true, journal: [], archive: [], allocateVersion: empty.allocateVersion });
  assertEquals((await readMasterJournalProjection(empty.master)).exists, true);
});

Deno.test("archive existence is checked and cannot contradict retained whole rows", async () => {
  const invalid = await legacyFixture();
  await assertRejects(() => stageMasterJournalCutover(invalid.master, {
    journalExists: true, journal: [], archiveExists: false, archive: [{ id: "old" }],
    allocateVersion: invalid.allocateVersion,
  }), Error, "archive existence");
  assertEquals(await readMasterJournalHead(invalid.master), null);

  const valid = await legacyFixture();
  const head = await stageMasterJournalCutover(valid.master, {
    journalExists: true, journal: [], archiveExists: true, archive: [],
    allocateVersion: valid.allocateVersion,
  });
  const wal = await valid.master.getDirectoryHandle("journal-wal");
  const malformed = await sealMasterJournalRecord("archive", {
    epoch: head.epoch, exists: "yes", rows: [],
  });
  (await wal.getFileHandle(head.archive)).bytes = encoder.encode(malformed);
  const hex = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const archiveHash = await hex(malformed);
  const lastHash = await hex(JSON.stringify({
    epoch: head.epoch, sequence: 0, checkpoint: head.checkpoint, archive: head.archive, archiveHash,
  }));
  (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...head, archiveHash, lastHash,
  }));
  await assertRejects(() => readMasterJournalProjection(valid.master, { includeArchive: true }), Error, "archive segment is corrupt");
});

Deno.test("failed archive publication cannot select staged checkpoint or displace legacy journal", async () => {
  const faults = { close: "archive-18-0.json" };
  const { master, legacy, allocateVersion } = await legacyFixture(faults);
  await assertRejects(() => stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion,
  }), Error, "injected close");
  assertEquals(await readMasterJournalHead(master), null);
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy);
  faults.close = null;
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion });
  assertEquals((await readMasterJournalProjection(master)).version, 19, "retry uses a new generation");
});

Deno.test("failed terminal head close is not acknowledged and a corrupt present head fails closed", async () => {
  const faults = { close: "head-a.json" };
  const { master, legacy, allocateVersion } = await legacyFixture(faults);
  await assertRejects(() => stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion,
  }), Error, "injected close");
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy);
  await assertRejects(() => readMasterJournalHead(master), Error, "corrupt");
  // No silent fallback to the stale legacy value despite an intact backup.
  await assertRejects(() => readMasterJournalProjection(master), Error, "corrupt");
});

Deno.test("one corrupt head and one absent is not proof of a never-published cutover", async () => {
  const { master, legacy, allocateVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ type: "acknowledged", id: 2 }], archive: [], allocateVersion,
  });
  assertEquals((await readMasterJournalProjection(master)).live, [{ type: "acknowledged", id: 2 }]);
  const wal = await master.getDirectoryHandle("journal-wal");
  const published = await wal.getFileHandle("head-a.json");
  published.bytes = published.bytes.slice(0, 9); // corruption AFTER successful publication
  await assertRejects(() => readMasterJournalProjection(master), Error, "corrupt");
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy,
    "the stale legacy journal still exists but cannot be trusted as recovery authority");
});

Deno.test("published but missing or changed checkpoint fails closed; incomplete frame suffix is not replayed", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const head = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion,
  });
  const wal = await master.getDirectoryHandle("journal-wal");
  const checkpoint = await wal.getFileHandle(head.checkpoint);
  checkpoint.bytes = checkpoint.bytes.slice(0, 8);
  await assertRejects(() => readMasterJournalProjection(master), Error, "corrupt");
  // A syntactically valid head at a newer sequence cannot be treated as an
  // old checkpoint when the framed writer has not been installed yet.
  checkpoint.bytes = encoder.encode(await sealMasterJournalRecord("checkpoint", {
    epoch: head.epoch, sequence: 0, exists: true, live: [{ id: 1 }],
  }));
  const newer = { ...head, sequence: 1, version: 19 };
  (await wal.getFileHandle("head-b.json", { create: true })).bytes = encoder.encode(await sealMasterJournalRecord("head", newer));
  await assertRejects(() => readMasterJournalProjection(master), Error, "frame 1 is missing");
});

Deno.test("immutable checked frames replay without changing raw legacy; missing acknowledged frame refuses", async () => {
  const { master, legacy, allocateVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion });
  const head = await stageMasterJournalFrame(master, { operation: "append", row: { id: 2 } }, { allocateVersion });
  assertEquals(head.sequence, 1);
  assertEquals((await readMasterJournalProjection(master)).live, [{ id: 1 }, { id: 2 }]);
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy);
  const wal = await master.getDirectoryHandle("journal-wal");
  const frame = await wal.getFileHandle(`frame-${head.epoch}-1.json`);
  frame.bytes = encoder.encode("{\"torn\":");
  await assertRejects(() => readMasterJournalProjection(master), Error, "corrupt");
});

Deno.test("failed immutable frame close is not published, failed head close refuses rather than falling back", async () => {
  const faults = {};
  const { master, allocateVersion } = await legacyFixture(faults);
  const head = await stageMasterJournalCutover(master, { journalExists: true, journal: [], archive: [], allocateVersion });
  faults.close = `frame-${head.epoch}-1.json`;
  await assertRejects(() => stageMasterJournalFrame(master, { operation: "append", row: { id: 1 } }, { allocateVersion }), Error, "injected close");
  assertEquals((await readMasterJournalProjection(master)).live, [], "unpublished frame is not authority");
  faults.close = "head-b.json";
  await assertRejects(() => stageMasterJournalFrame(master, { operation: "append", row: { id: 1 } }, { allocateVersion }), Error, "injected close");
  await assertRejects(() => readMasterJournalProjection(master), Error, "corrupt");
});

Deno.test("checked frame chain applies 500 cap, preserves overflow and fences clear", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const live = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: live, archive: [], allocateVersion });
  await stageMasterJournalFrame(master, { operation: "append", row: { id: 500 } }, { allocateVersion });
  const grown = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(grown.live.length, 500);
  assertEquals(grown.live[0].id, 1);
  assertEquals(grown.archive, [{ id: 0 }]);
  await stageMasterJournalFrame(master, { operation: "clear" }, { allocateVersion });
  const cleared = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(cleared.exists, false);
  assertEquals(cleared.live, []);
  assertEquals(cleared.archive, []);
});

Deno.test("checksum, kind and UTF-8 corruption are refused rather than silently skipped", async () => {
  const original = await sealMasterJournalRecord("frame", { epoch: 1, sequence: 1, row: { result: "€" } });
  assertEquals((await unsealMasterJournalRecord(original, "frame")).row.result, "€");
  await assertRejects(() => unsealMasterJournalRecord(original.slice(0, -3), "frame"), Error, "corrupt");
  await assertRejects(() => unsealMasterJournalRecord(original.replace("€", "x"), "frame"), Error, "checksum mismatch");
  await assertRejects(() => unsealMasterJournalRecord(original, "head"), Error, "schema mismatch");
  await assertRejects(() => unsealMasterJournalRecord(Uint8Array.of(0xff), "frame"), Error, "corrupt");
});
