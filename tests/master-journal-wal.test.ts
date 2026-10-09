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
        this.faults?.writes?.push({ name: this.name, bytes: next.byteLength });
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
  const cutover = await stageMasterJournalCutover(master, {
    journalExists: true, journal, archive: [{ id: "archived" }], allocateVersion,
  });
  for (const digest of [cutover.archiveHash, cutover.checkpointHash]) {
    assertEquals(/^[0-9a-f]{64}$/.test(digest), true, "new heads bind both immutable record bytes");
  }
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

Deno.test("published head binds exact checkpoint bytes, not only a reusable filename", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const head = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: "acknowledged" }], archive: [], allocateVersion,
  });
  const wal = await master.getDirectoryHandle("journal-wal");
  const checkpoint = await wal.getFileHandle(head.checkpoint);
  const original = await unsealMasterJournalRecord(checkpoint.bytes, "checkpoint");
  checkpoint.bytes = encoder.encode(await sealMasterJournalRecord("checkpoint", {
    ...original, live: [{ id: "different-but-resealed" }],
  }));
  await assertRejects(() => readMasterJournalProjection(master), Error, "checkpoint hash mismatch");
});

Deno.test("re-sealed archive chain cannot skip an acknowledged interior segment", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const rows = Array.from({ length: 1_201 }, (_, id) => ({ id }));
  const head = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [], archive: rows, allocateVersion,
  });
  const wal = await master.getDirectoryHandle("journal-wal");
  const rootName = `archive-${head.epoch}-0.json`;
  const rootText = decoder.decode((await wal.getFileHandle(rootName)).bytes);
  const hash = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const tail = await wal.getFileHandle(head.archive);
  const old = await unsealMasterJournalRecord(tail.bytes, "archive");
  const altered = await sealMasterJournalRecord("archive", {
    ...old, previous: rootName, previousHash: await hash(rootText),
  });
  tail.bytes = encoder.encode(altered);
  const archiveHash = await hash(altered);
  const lastHash = await hash(JSON.stringify({
    epoch: head.epoch, sequence: 0, checkpoint: head.checkpoint, archive: head.archive, archiveHash,
    checkpointHash: head.checkpointHash,
  }));
  (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...head, archiveHash, lastHash,
  }));
  await assertRejects(() => readMasterJournalProjection(master, { includeArchive: true }), Error, "predecessor");
});

Deno.test("nonzero archive root requires an explicit reset witness, and linked segments cannot claim reset", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const head = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [],
    archive: Array.from({ length: 501 }, (_, id) => ({ id })), allocateVersion,
  });
  const wal = await master.getDirectoryHandle("journal-wal");
  const leaf = await wal.getFileHandle(head.archive);
  const original = await unsealMasterJournalRecord(leaf.bytes, "archive");
  const digest = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const rebind = async (altered) => {
    const sealed = await sealMasterJournalRecord("archive", altered);
    leaf.bytes = encoder.encode(sealed);
    const archiveHash = await digest(sealed);
    const lastHash = await digest(JSON.stringify({
      epoch: head.epoch, sequence: 0, checkpoint: head.checkpoint, archive: head.archive,
      archiveHash, checkpointHash: head.checkpointHash,
    }));
    (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
      ...head, archiveHash, lastHash,
    }));
  };
  await rebind({ ...original, previous: null, previousHash: null });
  await assertRejects(() => readMasterJournalProjection(master, { includeArchive: true }), Error, "reset witness");
  await rebind({ ...original, reset: true });
  await assertRejects(() => readMasterJournalProjection(master, { includeArchive: true }), Error, "predecessor");
});

Deno.test("master journal cutover preserves absent versus present-empty", async () => {
  const absent = await legacyFixture();
  await stageMasterJournalCutover(absent.master, { journalExists: false, journal: [], archive: [], allocateVersion: absent.allocateVersion });
  assertEquals((await readMasterJournalProjection(absent.master)).exists, false);
  const empty = await legacyFixture();
  await stageMasterJournalCutover(empty.master, { journalExists: true, journal: [], archive: [], allocateVersion: empty.allocateVersion });
  assertEquals((await readMasterJournalProjection(empty.master)).exists, true);
});

Deno.test("absent journal cannot cut over while retaining live rows", async () => {
  const { master, allocateVersion } = await legacyFixture();
  await assertRejects(() => stageMasterJournalCutover(master, {
    journalExists: false, journal: [{ id: "unacknowledged" }], archive: [], allocateVersion,
  }), Error, "journal existence contradicts");
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
    checkpointHash: head.checkpointHash,
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
  const originalCheckpoint = checkpoint.bytes.slice();
  checkpoint.bytes = checkpoint.bytes.slice(0, 8);
  await assertRejects(() => readMasterJournalProjection(master), Error, "checkpoint hash mismatch");
  // A syntactically valid head at a newer sequence cannot be treated as an
  // old checkpoint when the framed writer has not been installed yet.
  checkpoint.bytes = originalCheckpoint;
  const newer = { ...head, sequence: 1, version: 19 };
  (await wal.getFileHandle("head-b.json", { create: true })).bytes = encoder.encode(await sealMasterJournalRecord("head", newer));
  await assertRejects(() => readMasterJournalProjection(master), Error, "frame 1 is missing");
});

Deno.test("newer head slot cannot publish a regressed or reused version token", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const old = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion,
  });
  const newer = await stageMasterJournalFrame(master, { operation: "append", row: { id: 2 } }, { allocateVersion });
  const wal = await master.getDirectoryHandle("journal-wal");
  (await wal.getFileHandle("head-b.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...newer, version: old.version,
  }));
  await assertRejects(() => readMasterJournalHead(master), Error, "version");
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
  // A separate profile isolates the head fault; the torn frame above now
  // correctly blocks retry rather than being overwritten without repair.
  const headFaults = { close: "head-b.json" };
  const second = await legacyFixture(headFaults);
  await stageMasterJournalCutover(second.master, {
    journalExists: true, journal: [], archive: [], allocateVersion: second.allocateVersion,
  });
  await assertRejects(() => stageMasterJournalFrame(second.master, {
    operation: "append", row: { id: 1 },
  }, { allocateVersion: second.allocateVersion }), Error, "injected close");
  await assertRejects(() => readMasterJournalProjection(second.master), Error, "corrupt");
});

Deno.test("an unpublished torn immutable frame blocks retry until explicit repair", async () => {
  const faults = { close: "frame-18-1.json" };
  const { master, allocateVersion } = await legacyFixture(faults);
  await stageMasterJournalCutover(master, { journalExists: true, journal: [], archive: [], allocateVersion });
  await assertRejects(() => stageMasterJournalFrame(master, {
    operation: "append", row: { id: "unacknowledged" },
  }, { allocateVersion }), Error, "injected close");
  assertEquals((await readMasterJournalProjection(master)).live, []);
  faults.close = null;
  await assertRejects(() => stageMasterJournalFrame(master, {
    operation: "append", row: { id: "retry-must-not-erase-evidence" },
  }, { allocateVersion }), Error, "unpublished");
  assertEquals((await readMasterJournalProjection(master)).live, []);
});

Deno.test("WAL frame CAS refuses a stale same-value token and wrong epoch before allocating a write", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const cutover = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: "same" }], archive: [], allocateVersion,
  });
  const next = await stageMasterJournalFrame(master, {
    operation: "replace", rows: [{ id: "same" }],
  }, { allocateVersion, expectedVersion: cutover.version, expectedEpoch: cutover.epoch });
  assertEquals(next.version > cutover.version, true, "same-value writes must consume a fresh token");
  await assertRejects(() => stageMasterJournalFrame(master, {
    operation: "replace", rows: [{ id: "stale" }],
  }, { allocateVersion, expectedVersion: cutover.version, expectedEpoch: cutover.epoch }), Error, "CAS version mismatch");
  await assertRejects(() => stageMasterJournalFrame(master, {
    operation: "append", row: { id: "wrong-epoch" },
  }, { allocateVersion, expectedVersion: next.version, expectedEpoch: cutover.epoch + 1 }), Error, "epoch mismatch");
  assertEquals((await readMasterJournalProjection(master)).live, [{ id: "same" }]);
  const wal = await master.getDirectoryHandle("journal-wal");
  assertEquals(wal.children.has(`frame-${cutover.epoch}-2.json`), false,
    "refused CAS must not leave an unpublished immutable frame");
});

Deno.test("stale WAL CAS cannot trigger compaction side effects at the 128-frame boundary", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const cutover = await stageMasterJournalCutover(master, {
    journalExists: true, journal: Array.from({ length: 500 }, (_, id) => ({ id })),
    archive: [], allocateVersion,
  });
  let head;
  for (let id = 500; id < 628; id++) {
    head = await stageMasterJournalFrame(master, { operation: "append", row: { id } }, { allocateVersion });
  }
  const wal = await master.getDirectoryHandle("journal-wal");
  await assertRejects(() => stageMasterJournalFrame(master, {
    operation: "append", row: { id: "stale-CAS" },
  }, { allocateVersion, expectedEpoch: cutover.epoch, expectedVersion: head.version - 1 }), Error, "CAS version mismatch");
  assertEquals(wal.children.has(`archive-${head.epoch}-1.json`), false);
  assertEquals(wal.children.has(`checkpoint-${head.epoch}-129.json`), false);
  assertEquals((await readMasterJournalProjection(master)).head.version, head.version);
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

Deno.test("after 128 frames a verified compaction rolls overflow into bounded segments without discarding rows", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const live = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, {
    journalExists: true, journal: live, archive: [{ id: "prior" }], allocateVersion,
  });
  let head;
  for (let id = 500; id < 629; id++) {
    head = await stageMasterJournalFrame(master, { operation: "append", row: { id } }, { allocateVersion });
  }
  assertEquals(head.checkpointSequence > 0, true, "the 129th append must not exceed the 128-frame replay bound");
  for (const digest of [head.archiveHash, head.checkpointHash]) {
    assertEquals(/^[0-9a-f]{64}$/.test(digest), true, "compacted framed heads retain both byte hashes");
  }
  const projection = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projection.live.length, 500);
  assertEquals(projection.live[0].id, 129);
  assertEquals(projection.archive, [{ id: "prior" }, ...live.slice(0, 129)]);
  const wal = await master.getDirectoryHandle("journal-wal");
  const segments = [...wal.children.entries()].filter(([name]) => /^archive-\d+-\d+\.json$/.test(name));
  for (const [, file] of segments) {
    const part = await unsealMasterJournalRecord(file.bytes, "archive");
    assertEquals(part.rows.length <= 500, true);
  }
});

Deno.test("300 framed appends write only one frame and head except at bounded compactions", async () => {
  const faults = { writes: [] };
  const { master, allocateVersion } = await legacyFixture(faults);
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  faults.writes.length = 0;
  for (let step = 0; step < 300; step++) {
    const start = faults.writes.length;
    await stageMasterJournalFrame(master, { operation: "append", row: { id: step + 500 } }, { allocateVersion });
    const written = faults.writes.slice(start);
    const archived = written.filter(({ name }) => name.startsWith("archive-"));
    const compaction = step === 128 || step === 256;
    assertEquals(archived.length, compaction ? 1 : 0,
      `append ${step}: no separate archive write outside verified compaction`);
    const frames = written.filter(({ name }) => name.startsWith("frame-"));
    assertEquals(frames.length, 1);
    const rowBytes = encoder.encode(JSON.stringify({ id: step + 500 })).byteLength;
    assertEquals(frames[0].bytes <= 512 + 4 * rowBytes, true,
      `append ${step}: the frame must not copy the live ring`);
    const heads = written.filter(({ name }) => name.startsWith("head-"));
    assertEquals(heads.length, compaction ? 2 : 1);
    assertEquals(heads.every(({ bytes }) => bytes < 1024), true, "heads stay small");
    assertEquals(written.every(({ name }) => name !== "journal.json"), true);
    assertEquals(written.length <= 5, true, `append ${step}: bounded explicit file writes`);
  }
  const cumulativeBytes = faults.writes.reduce((sum, { bytes }) => sum + bytes, 0);
  const boundedBytes = 300 * (512 + 4 * 32 + 1024) +
    2 * (1024 + 4 * 32 * 500) + 2 * (1024 + 4 * 32 * 128);
  assertEquals(cumulativeBytes <= boundedBytes, true, "300 appends have a finite constant-size write budget");
  assertEquals((await readMasterJournalProjection(master, { includeArchive: true })).archive.length, 300);
});

Deno.test("clear then compaction starts a fresh archive chain without resurrecting prior rows", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const first = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: "old-live" }], archive: [{ id: "old-archive" }], allocateVersion,
  });
  const wal = await master.getDirectoryHandle("journal-wal");
  const originalArchive = (await wal.getFileHandle(first.archive)).bytes.slice();
  await stageMasterJournalFrame(master, { operation: "clear" }, { allocateVersion });
  let head;
  for (let id = 0; id < 128; id++) {
    head = await stageMasterJournalFrame(master, { operation: "append", row: { id } }, { allocateVersion });
  }
  assertEquals(head.archive, `archive-${first.epoch}-1.json`, "reset uses the next UNUSED segment name");
  assertEquals((await wal.getFileHandle(first.archive)).bytes, originalArchive,
    "the other head still needs the prior sealed archive until it advances");
  const root = await unsealMasterJournalRecord((await wal.getFileHandle(head.archive)).bytes, "archive");
  assertEquals(root.reset, true);
  assertEquals(root.previous, null, "clear must not link a retained old archive into the new authority");
  assertEquals(root.exists, false);
  const projection = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projection.live.length, 128);
  assertEquals(projection.archiveExists, false);
  assertEquals(projection.archive, []);
});

Deno.test("compaction faults before publication retain old authority; torn head refuses recovery", async () => {
  for (const [phase, corruptHead] of [
    ["archive-18-1.json", false], ["checkpoint-18-129.json", false], ["head-b.json", true],
  ]) {
    const faults = {};
    const { master, allocateVersion } = await legacyFixture(faults);
    const live = Array.from({ length: 500 }, (_, id) => ({ id }));
    await stageMasterJournalCutover(master, { journalExists: true, journal: live, archive: [], allocateVersion });
    for (let id = 500; id < 628; id++) {
      await stageMasterJournalFrame(master, { operation: "append", row: { id } }, { allocateVersion });
    }
    faults.close = phase;
    await assertRejects(() => stageMasterJournalFrame(master, {
      operation: "append", row: { id: "unacknowledged" },
    }, { allocateVersion }), Error, "injected close");
    if (corruptHead) {
      await assertRejects(() => readMasterJournalProjection(master), Error, "corrupt");
    } else {
      const old = await readMasterJournalProjection(master, { includeArchive: true });
      assertEquals(old.head.sequence, 128, `${phase} must leave old head authoritative`);
      assertEquals(old.live[0].id, 128);
      assertEquals(old.archive, live.slice(0, 128));
    }
  }
});

Deno.test("even a re-bound checkpoint must carry an in-range, matching durable generation", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const head = await stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion,
  });
  const wal = await master.getDirectoryHandle("journal-wal");
  const checkpoint = await wal.getFileHandle(head.checkpoint);
  const original = await unsealMasterJournalRecord(checkpoint.bytes, "checkpoint");
  const digest = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const rebind = async (version) => {
    const sealed = await sealMasterJournalRecord("checkpoint", { ...original, version });
    checkpoint.bytes = encoder.encode(sealed);
    const checkpointHash = await digest(sealed);
    const lastHash = await digest(JSON.stringify({
      epoch: head.epoch, sequence: head.checkpointSequence, checkpoint: head.checkpoint,
      archive: head.archive, archiveHash: head.archiveHash, checkpointHash,
    }));
    (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
      ...head, checkpointHash, lastHash,
    }));
  };
  await rebind(head.epoch - 1);
  await assertRejects(() => readMasterJournalProjection(master), Error, "checkpoint version is corrupt");
  await rebind(head.version + 1);
  await assertRejects(() => readMasterJournalProjection(master), Error, "checkpoint version is corrupt");
});

Deno.test("frame after compaction cannot roll its version below the checkpoint generation", async () => {
  const { master, allocateVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: true, journal: [], archive: [], allocateVersion });
  let newer;
  for (let id = 1; id <= 129; id++) {
    newer = await stageMasterJournalFrame(master, { operation: "append", row: { id } }, { allocateVersion });
  }
  const wal = await master.getDirectoryHandle("journal-wal");
  const compact = await unsealMasterJournalRecord((await wal.getFileHandle("head-b.json")).bytes, "head");
  const file = await wal.getFileHandle(`frame-${newer.epoch}-${newer.sequence}.json`);
  const frame = await unsealMasterJournalRecord(file.bytes, "frame");
  const altered = await sealMasterJournalRecord("frame", { ...frame, version: compact.version - 1 });
  file.bytes = encoder.encode(altered);
  const lastHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(altered)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...newer, version: compact.version - 1, lastHash,
  }));
  wal.children.delete("head-b.json"); // only the newer head-a remains
  await assertRejects(() => readMasterJournalProjection(master), Error, "version");
});

Deno.test("checksum, kind and UTF-8 corruption are refused rather than silently skipped", async () => {
  const original = await sealMasterJournalRecord("frame", { epoch: 1, sequence: 1, row: { result: "€" } });
  assertEquals((await unsealMasterJournalRecord(original, "frame")).row.result, "€");
  await assertRejects(() => unsealMasterJournalRecord(original.slice(0, -3), "frame"), Error, "corrupt");
  await assertRejects(() => unsealMasterJournalRecord(original.replace("€", "x"), "frame"), Error, "checksum mismatch");
  await assertRejects(() => unsealMasterJournalRecord(original, "head"), Error, "schema mismatch");
  await assertRejects(() => unsealMasterJournalRecord(Uint8Array.of(0xff), "frame"), Error, "corrupt");
});
