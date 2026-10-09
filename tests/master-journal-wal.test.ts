// @ts-nocheck — injected OPFS handles are deliberately minimal and faultable.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  readMasterJournalHead,
  readMasterJournalProjection,
  sealMasterJournalRecord,
  stageMasterJournalCutover,
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

Deno.test("master journal cutover preserves absent versus present-empty", async () => {
  const absent = await legacyFixture();
  await stageMasterJournalCutover(absent.master, { journalExists: false, journal: [], archive: [], allocateVersion: absent.allocateVersion });
  assertEquals((await readMasterJournalProjection(absent.master)).exists, false);
  const empty = await legacyFixture();
  await stageMasterJournalCutover(empty.master, { journalExists: true, journal: [], archive: [], allocateVersion: empty.allocateVersion });
  assertEquals((await readMasterJournalProjection(empty.master)).exists, true);
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
  await assertRejects(() => readMasterJournalProjection(master), Error, "frame replay is not enabled");
});

Deno.test("checksum, kind and UTF-8 corruption are refused rather than silently skipped", async () => {
  const original = await sealMasterJournalRecord("frame", { epoch: 1, sequence: 1, row: { result: "€" } });
  assertEquals((await unsealMasterJournalRecord(original, "frame")).row.result, "€");
  await assertRejects(() => unsealMasterJournalRecord(original.slice(0, -3), "frame"), Error, "corrupt");
  await assertRejects(() => unsealMasterJournalRecord(original.replace("€", "x"), "frame"), Error, "checksum mismatch");
  await assertRejects(() => unsealMasterJournalRecord(original, "head"), Error, "schema mismatch");
  await assertRejects(() => unsealMasterJournalRecord(Uint8Array.of(0xff), "frame"), Error, "corrupt");
});
