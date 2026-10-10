// @ts-nocheck — injected OPFS handles are deliberately minimal and faultable.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { dumpLogBuffer } from "../extension/lib/cap-log.js";
import { createMasterJournalIssuer } from "../extension/lib/master-journal-issuer.js";
import {
  fingerprintMasterJournalRepairEvidence,
  fingerprintRequestedMasterJournalRepairLeaves,
  inspectMasterJournalForOwner,
  snapshotMasterJournalRepairEvidence,
} from "../extension/lib/master-journal-owner-inspection.js";
import { inspectIntactMasterJournalPrefixesForOwner } from "../extension/lib/master-journal-repair-prefix.js";
import { deriveMasterJournalQuarantineManifest } from "../extension/lib/master-journal-quarantine-manifest.js";
import { collectMasterJournalRepairEvidenceInventory } from "../extension/lib/master-journal-repair-evidence.js";
import {
  inspectMasterJournalQuarantineRetentionForOwner,
  stageMasterJournalQuarantineCopy,
} from "../extension/lib/master-journal-quarantine-copy.js";
import {
  selectPublishedMasterJournalBackupPaths,
  validateStagedMasterJournalBackup,
} from "../extension/lib/master-journal-backup.js";
import {
  appendMasterJournalRow,
  appendMasterJournalWithReceipt,
  compensateMasterJournalReceipt,
  cancelMasterJournalExecution,
} from "../extension/lib/master-journal-transaction.js";
import {
  readMasterJournalHead,
  readMasterJournalProjection,
  sealMasterJournalRecord,
  stageMasterJournalRepairIntent,
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
  async removeEntry(name) {
    if (this.faults?.remove === name) throw new Error(`injected remove ${name}`);
    if (!this.children.delete(name)) throw missing(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (create && this.faults?.create === name) throw new Error(`injected create ${name}`);
    if (!this.children.has(name)) {
      if (!create) throw missing(name);
      this.children.set(name, new MemoryFile(name, this.faults));
    }
    return this.children.get(name);
  }
  async *entries() {
    yield* this.children.entries();
  }
}

async function legacyFixture(faults = {}) {
  const master = new MemoryDir("master", faults);
  const legacy = JSON.stringify({ __v: 17, __value: [{ type: "old", id: 1 }] });
  (await master.getFileHandle("journal.json", { create: true })).bytes = encoder.encode(legacy);
  let generation = 17;
  const issued = new Map();
  const claimKey = ({ checkpoint, source }) => `${checkpoint}:${JSON.stringify(source)}`;
  return { master, legacy, allocateVersion: async (claim = null) => {
    const version = ++generation;
    if (claim) issued.set(claimKey(claim), version); // fake durable claim authority
    return version;
  }, readIssuedVersion: async (claim) => issued.get(claimKey(claim)) ?? null,
    readGeneration: async () => generation };
}

Deno.test("quarantine retention manifest derives distinct immutable names without copying bytes", async () => {
  const sourceSha256 = "a".repeat(64);
  const intent = { schemaVersion: 1, sequence: 2,
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", evidenceSha256: "b".repeat(64),
    requestedRepairRecords: [
      { name: "frame-1-2.json", bytes: 8, sha256: sourceSha256 },
      { name: "head-a.json", bytes: 8, sha256: sourceSha256 },
    ] };
  const manifest = await deriveMasterJournalQuarantineManifest(intent);
  assertEquals(manifest.actionable, false);
  assertEquals(manifest.candidates, []);
  assertEquals(manifest.entries.length, 2);
  assertEquals(manifest.entries[0].quarantineLeaf === manifest.entries[1].quarantineLeaf, false,
    "equal raw content at two source names must never collide");
  assertEquals(manifest.entries.every((entry) => /^quarantine-2-[0-9a-f]{64}\.json$/.test(entry.quarantineLeaf)), true);
  assertEquals(/^[0-9a-f]{64}$/.test(manifest.sha256), true);
  assertEquals((await deriveMasterJournalQuarantineManifest(intent)).sha256, manifest.sha256);
  assertEquals((await deriveMasterJournalQuarantineManifest({ ...intent,
    requestedRepairRecords: [{ ...intent.requestedRepairRecords[0], sha256: "c".repeat(64) },
      intent.requestedRepairRecords[1]],
  })).sha256 === manifest.sha256, false);
  await assertRejects(() => deriveMasterJournalQuarantineManifest({ ...intent,
    requestedRepairRecords: [intent.requestedRepairRecords[1], intent.requestedRepairRecords[0]],
  }), Error, "sorted");
});

Deno.test("test-only quarantine copy retains exact raw bytes and refuses changed source", async () => {
  const { master, legacy } = await legacyFixture();
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  const source = "head-a.json";
  const original = encoder.encode("{ torn secret-shaped evidence");
  (await wal.getFileHandle(source, { create: true })).bytes = original.slice();
  const plan = await fingerprintRequestedMasterJournalRepairLeaves(master, [source]);
  const intent = await stageMasterJournalRepairIntent(master, {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", reason: "torn-head",
    expectedEvidenceSha256: plan.evidenceSha256, requestedRepairLeaves: [source],
  });
  const expected = await deriveMasterJournalQuarantineManifest(intent);
  const copied = await stageMasterJournalQuarantineCopy(master,
    { intentSequence: 1, sourceName: source });
  assertEquals(copied.quarantineLeaf, expected.entries[0].quarantineLeaf);
  assertEquals(copied.reused, false);
  assertEquals((await wal.getFileHandle(copied.quarantineLeaf)).bytes, original);
  assertEquals((await stageMasterJournalQuarantineCopy(master,
    { intentSequence: 1, sourceName: source })).reused, true);
  (await wal.getFileHandle(source)).bytes = encoder.encode("{ changed evidence");
  await assertRejects(() => stageMasterJournalQuarantineCopy(master,
    { intentSequence: 1, sourceName: source }), Error, "source changed");
  assertEquals((await wal.getFileHandle(copied.quarantineLeaf)).bytes, original);
  await assertRejects(() => readMasterJournalHead(master), Error);
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy);
});

Deno.test("read-only owner retention inspection verifies all copies and refuses orphan bytes", async () => {
  const { master } = await legacyFixture();
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  const source = "head-a.json";
  (await wal.getFileHandle(source, { create: true })).bytes = encoder.encode("{ torn and retained");
  const plan = await fingerprintRequestedMasterJournalRepairLeaves(master, [source]);
  const intent = await stageMasterJournalRepairIntent(master, {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", reason: "torn-head",
    expectedEvidenceSha256: plan.evidenceSha256, requestedRepairLeaves: [source],
  });
  await assertRejects(() => inspectMasterJournalQuarantineRetentionForOwner(master,
    { lastIntentSequence: 1 }), Error, "missing");
  const copy = await stageMasterJournalQuarantineCopy(master,
    { intentSequence: 1, sourceName: source });
  const beforeInspect = [...wal.children].map(([name, handle]) => [name, handle.bytes.slice()]);
  const inspected = await inspectMasterJournalQuarantineRetentionForOwner(master,
    { lastIntentSequence: 1 });
  assertEquals([...wal.children].map(([name, handle]) => [name, handle.bytes]), beforeInspect,
    "forensic inspection must not alter any WAL leaf");
  assertEquals(inspected.manifestSha256, (await deriveMasterJournalQuarantineManifest(intent)).sha256);
  assertEquals(inspected.copyCount, 1);
  assertEquals(inspected.actionable, false);
  assertEquals(inspected.candidates, []);
  (await wal.getFileHandle(copy.quarantineLeaf)).bytes = encoder.encode("{ altered copy");
  await assertRejects(() => inspectMasterJournalQuarantineRetentionForOwner(master,
    { lastIntentSequence: 1 }), Error, "mismatched");
  (await wal.getFileHandle(copy.quarantineLeaf)).bytes = (await wal.getFileHandle(source)).bytes.slice();
  const orphan = `quarantine-1-${"f".repeat(64)}.json`;
  (await wal.getFileHandle(orphan, { create: true })).bytes = encoder.encode("orphan");
  await assertRejects(() => inspectMasterJournalQuarantineRetentionForOwner(master,
    { lastIntentSequence: 1 }), Error, "unbound");
  await assertRejects(() => readMasterJournalHead(master), Error);
});

Deno.test("torn quarantine copy never overwrites source or repairs itself on retry", async () => {
  const faults = {};
  const { master, legacy } = await legacyFixture(faults);
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  const source = "head-a.json";
  const original = encoder.encode("{ corrupt evidence must survive");
  (await wal.getFileHandle(source, { create: true })).bytes = original.slice();
  const plan = await fingerprintRequestedMasterJournalRepairLeaves(master, [source]);
  const intent = await stageMasterJournalRepairIntent(master, {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", reason: "torn-head",
    expectedEvidenceSha256: plan.evidenceSha256, requestedRepairLeaves: [source],
  });
  const target = (await deriveMasterJournalQuarantineManifest(intent)).entries[0].quarantineLeaf;
  faults.close = target;
  await assertRejects(() => stageMasterJournalQuarantineCopy(master,
    { intentSequence: 1, sourceName: source }), Error, "injected close");
  const torn = (await wal.getFileHandle(target)).bytes.slice();
  faults.close = undefined;
  await assertRejects(() => stageMasterJournalQuarantineCopy(master,
    { intentSequence: 1, sourceName: source }), Error, "torn or mismatched");
  assertEquals((await wal.getFileHandle(target)).bytes, torn);
  assertEquals((await wal.getFileHandle(source)).bytes, original);
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy);
  await assertRejects(() => readMasterJournalHead(master), Error);
});

Deno.test("nonempty repair witness cannot discharge without a checked quarantine retention manifest", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const head = await stageMasterJournalCutover(master, { journalExists: true,
    journal: [{ id: "owned" }], archive: [], allocateVersion });
  const wal = await master.getDirectoryHandle("journal-wal");
  const torn = `frame-${head.epoch}-1.json`;
  (await wal.getFileHandle(torn, { create: true })).bytes = encoder.encode("{ torn");
  const plan = await fingerprintRequestedMasterJournalRepairLeaves(master, [torn]);
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await stageMasterJournalRepairIntent(master, {
    id, reason: "orphan-record", expectedEvidenceSha256: plan.evidenceSha256,
    requestedRepairLeaves: [torn],
  });
  (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...head, repairIntentSequence: 1, repairIntentId: id,
  }));
  await assertRejects(() => readMasterJournalHead(master), Error,
    "quarantine retention manifest not yet verified");
  await assertRejects(() => readMasterJournalProjection(master), Error,
    "quarantine retention manifest not yet verified");
});

Deno.test("requested quarantine evidence is fingerprinted but cannot authorize moving bytes", async () => {
  const { master, legacy } = await legacyFixture();
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  const leaf = "head-a.json";
  (await wal.getFileHandle(leaf, { create: true })).bytes = encoder.encode("{ torn");
  const selected = await fingerprintRequestedMasterJournalRepairLeaves(master, [leaf]);
  assertEquals(selected.actionable, false);
  assertEquals(selected.candidates, []);
  assertEquals(selected.requestedRecords.length, 1);
  assertEquals(selected.requestedRecords[0].name, leaf);
  assertEquals(selected.requestedRecords[0].bytes, encoder.encode("{ torn").byteLength);
  assertEquals(/^[0-9a-f]{64}$/.test(selected.requestedRecords[0].sha256), true);
  await assertRejects(() => fingerprintRequestedMasterJournalRepairLeaves(master, [leaf, leaf]), Error);
  await assertRejects(() => fingerprintRequestedMasterJournalRepairLeaves(master,
    ["repair-intent-1.json"]), Error);
  const staged = await stageMasterJournalRepairIntent(master, {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", reason: "torn-head",
    expectedEvidenceSha256: selected.evidenceSha256, requestedRepairLeaves: [leaf],
  });
  assertEquals(staged.requestedRepairRecords, selected.requestedRecords,
    "immutable witness stores exact requested source bytes' fingerprints, not raw bytes");
  await assertRejects(() => readMasterJournalHead(master), Error);
  assertEquals(decoder.decode((await wal.getFileHandle(leaf)).bytes), "{ torn");
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy);
});

Deno.test("repair intent issuance refuses a changed owner evidence fingerprint before creating WAL", async () => {
  const { master } = await legacyFixture();
  const plan = await fingerprintMasterJournalRepairEvidence(master);
  (await master.getFileHandle("journal.json")).bytes = encoder.encode(JSON.stringify([{ id: "changed" }]));
  await assertRejects(() => stageMasterJournalRepairIntent(master, {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", reason: "pre-head-residue",
    expectedEvidenceSha256: plan.sha256,
  }), Error, "repair evidence changed");
  assertEquals(master.children.has("journal-wal"), false,
    "stale evidence must not even create the WAL authority directory");
});

Deno.test("durable repair-intent witness refuses missing or unmatched head without legacy fallback", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  const witnessId = "11111111-2222-4333-8444-555555555555";
  const firstEvidence = await fingerprintMasterJournalRepairEvidence(master);
  const staged = await stageMasterJournalRepairIntent(master, {
    id: witnessId, reason: "pre-head-residue", expectedEvidenceSha256: firstEvidence.sha256,
  });
  assertEquals(staged.id, witnessId);
  assertEquals(staged.evidenceSha256, firstEvidence.sha256,
    "durable witness must retain the exact owner-observed source fingerprint");
  const witness = await wal.getFileHandle("repair-intent-1.json");
  const witnessBytes = witness.bytes.slice();
  const pendingEvidence = await fingerprintMasterJournalRepairEvidence(master);
  await assertRejects(() => stageMasterJournalRepairIntent(master, {
    id: witnessId, reason: "pre-head-residue", expectedEvidenceSha256: pendingEvidence.sha256,
  }), Error, "repair intent");
  assertEquals(witness.bytes, witnessBytes, "an exact retry must not overwrite append-only repair evidence");
  await assertRejects(() => readMasterJournalHead(master), Error, "repair intent");
  await assertRejects(() => readMasterJournalProjection(master), Error, "repair intent",
    "a missing head cannot reactivate legacy when durable repair is pending");
  // Simulate a separately owner-approved, readback-verified publication in
  // this fake only; the product still has NO repair publisher or live writer.
  wal.children.delete("repair-intent-1.json");
  const first = await stageMasterJournalCutover(master, { journalExists: true,
    journal: [{ id: "owned" }], archive: [], allocateVersion });
  wal.children.set("repair-intent-1.json", witness);
  await assertRejects(() => readMasterJournalHead(master), Error, "repair intent",
    "an older intact head without the witness cannot silently win");
  const signedHead = await wal.getFileHandle("head-a.json");
  signedHead.bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...first, repairIntentId: witnessId, repairIntentSequence: 1,
  }));
  assertEquals((await readMasterJournalHead(master)).repairIntentId, witnessId);
  for (let i = 0; i < 129; i++) {
    await stageMasterJournalFrame(master, { operation: "append", row: { id: `after-repair-${i}` } },
      { allocateVersion });
  }
  assertEquals((await readMasterJournalHead(master)).repairIntentId, witnessId,
    "compaction and head-slot rotation must retain the exact repair witness identity");
  wal.children.delete("repair-intent-1.json");
  await assertRejects(() => readMasterJournalHead(master), Error, "repair witness is missing",
    "a checked head cannot discharge a removed witness by omission");
});

Deno.test("cycle-free raw repair inventory preserves the owner snapshot fingerprint", async () => {
  const { master } = await legacyFixture();
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  (await wal.getFileHandle("head-a.json", { create: true })).bytes = encoder.encode("{ torn");
  const raw = await collectMasterJournalRepairEvidenceInventory(master);
  const owner = await snapshotMasterJournalRepairEvidence(master);
  assertEquals(raw.walPresent, owner.walPresent);
  assertEquals(raw.records, owner.records);
  assertEquals(raw.legacy, owner.legacy);
  assertEquals(raw.actionable, false);
  assertEquals(raw.candidates, []);
  assertEquals(owner.state, "requires_explicit_owner_repair");
  const requested = await fingerprintRequestedMasterJournalRepairLeaves(master, ["head-a.json"]);
  const whole = await fingerprintMasterJournalRepairEvidence(master);
  assertEquals(requested.evidenceSha256, whole.sha256,
    "detached raw inventory must preserve the old evidence identity");
});

Deno.test("bounded owner evidence inventories 300 small staged frame-shaped leaves", async () => {
  const { master } = await legacyFixture();
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  for (let sequence = 1; sequence <= 300; sequence++) {
    (await wal.getFileHandle(`frame-1-${sequence}.json`, { create: true })).bytes = encoder.encode("x");
  }
  const inventory = await snapshotMasterJournalRepairEvidence(master);
  assertEquals(inventory.state, "requires_explicit_owner_repair");
  assertEquals(inventory.records.length, 300);
  assertEquals(inventory.actionable, false);
  assertEquals(inventory.candidates, []);
  assertEquals((await snapshotMasterJournalRepairEvidence(master, { maxRecords: 256 })).state,
    "inspection_refused", "an explicitly tighter owner budget must still refuse");
});

Deno.test("read-only repair plan fingerprint distinguishes absent WAL, empty WAL and changed legacy bytes", async () => {
  const { master } = await legacyFixture();
  const absent = await fingerprintMasterJournalRepairEvidence(master);
  assertEquals(absent.walPresent, false);
  assertEquals(/^[0-9a-f]{64}$/.test(absent.sha256), true);
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  const empty = await fingerprintMasterJournalRepairEvidence(master);
  assertEquals(empty.walPresent, true);
  assertEquals(empty.sha256 === absent.sha256, false,
    "empty-directory authority state must not share an absent-directory fingerprint");
  (await wal.getFileHandle("checkpoint-1-0.json", { create: true })).bytes = encoder.encode("{ partial");
  const residue = await fingerprintMasterJournalRepairEvidence(master);
  assertEquals(residue.sha256 === empty.sha256, false);
  (await master.getFileHandle("journal.json")).bytes = encoder.encode(JSON.stringify([{ id: "other" }]));
  const changedLegacy = await fingerprintMasterJournalRepairEvidence(master);
  assertEquals(changedLegacy.sha256 === residue.sha256, false);
  assertEquals(changedLegacy.actionable, false);
  assertEquals(changedLegacy.candidates, []);
});

Deno.test("owner prefix inspection isolates an intact older head without selecting legacy authority", async () => {
  const { master, legacy, allocateVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "owned" }],
    archive: [], allocateVersion });
  await stageMasterJournalFrame(master, { operation: "append", row: { id: "newer" } },
    { allocateVersion });
  const wal = await master.getDirectoryHandle("journal-wal");
  (await wal.getFileHandle("head-b.json")).bytes = encoder.encode("{ torn");
  await assertRejects(() => readMasterJournalHead(master), Error);
  const report = await inspectIntactMasterJournalPrefixesForOwner(master);
  assertEquals(report.actionable, false);
  assertEquals(report.candidates, []);
  assertEquals(report.heads.find((entry) => entry.slot === "head-a.json")?.checked, true);
  assertEquals(report.heads.find((entry) => entry.slot === "head-a.json")?.sequence, 0);
  assertEquals(/^[0-9a-f]{64}$/.test(report.heads.find((entry) => entry.slot === "head-a.json")?.sha256 ?? ""), true,
    "diagnostic metadata must bind the exact fingerprinted head bytes");
  assertEquals(report.heads.find((entry) => entry.slot === "head-b.json")?.checked, false);
  assertEquals(report.highestVerifiedHistoricalPrefix?.slot, "head-a.json");
  assertEquals(report.highestVerifiedHistoricalPrefix?.sequence, 0);
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy,
    "inspection never rewrites or selects legacy bytes");
  await assertRejects(() => readMasterJournalProjection(master), Error); // not authority
});

Deno.test("owner prefix inspection refuses missing checked prefix or oversized evidence", async () => {
  const { master, allocateVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "owned" }],
    archive: [], allocateVersion });
  const wal = await master.getDirectoryHandle("journal-wal");
  (await wal.getFileHandle("head-a.json")).bytes = encoder.encode("{ torn");
  const damaged = await inspectIntactMasterJournalPrefixesForOwner(master);
  assertEquals(damaged.actionable, false);
  assertEquals(damaged.candidates, []);
  assertEquals(damaged.heads.some((entry) => entry.checked), false,
    "no intact prefix exists; legacy must not become a candidate");
  assertEquals(damaged.highestVerifiedHistoricalPrefix, null);
  for (let i = 0; i < 1025; i++) {
    (await wal.getFileHandle(`residue-${i}.json`, { create: true })).bytes = encoder.encode("x");
  }
  const bounded = await inspectIntactMasterJournalPrefixesForOwner(master);
  assertEquals(bounded.state, "inspection_refused");
  assertEquals(bounded.candidates, []);
  const ownerExpanded = await inspectIntactMasterJournalPrefixesForOwner(master, { maxRecords: 2048 });
  assertEquals(ownerExpanded.state, "historical_prefix_diagnostic");
  assertEquals(ownerExpanded.highestVerifiedHistoricalPrefix, null);
  assertEquals(ownerExpanded.candidates, []);
  assertEquals(ownerExpanded.authoritySelected, false);
});

Deno.test("historical prefix diagnostic orders two checked heads without selecting authority", async () => {
  const { master, allocateVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "owned" }],
    archive: [], allocateVersion });
  await stageMasterJournalFrame(master, { operation: "append", row: { id: "newer" } },
    { allocateVersion });
  const report = await inspectIntactMasterJournalPrefixesForOwner(master);
  assertEquals(report.heads.filter((entry) => entry.checked).length, 2);
  assertEquals(report.highestVerifiedHistoricalPrefix?.slot, "head-b.json");
  assertEquals(report.highestVerifiedHistoricalPrefix?.sequence, 1);
  assertEquals(report.authoritySelected, false);
  assertEquals(report.candidates, []);
});

Deno.test("historical prefix diagnostic never chooses between equal head slots", async () => {
  const { master, allocateVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "owned" }],
    archive: [], allocateVersion });
  const wal = await master.getDirectoryHandle("journal-wal");
  (await wal.getFileHandle("head-b.json", { create: true })).bytes =
    (await wal.getFileHandle("head-a.json")).bytes.slice();
  const report = await inspectIntactMasterJournalPrefixesForOwner(master);
  assertEquals(report.heads.filter((entry) => entry.checked).length, 2);
  assertEquals(report.highestVerifiedHistoricalPrefix, null);
  assertEquals(report.actionable, false);
});

Deno.test("a newer immutable repair intent cannot be discharged by an older signed head", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const firstId = "11111111-2222-4333-8444-555555555555";
  const nextId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  await stageMasterJournalRepairIntent(master, { id: firstId, reason: "pre-head-residue",
    expectedEvidenceSha256: (await fingerprintMasterJournalRepairEvidence(master)).sha256 });
  const firstFile = await wal.getFileHandle("repair-intent-1.json");
  const firstBytes = firstFile.bytes.slice();
  // Simulate only a separately approved, checked head publication in a fake.
  wal.children.delete("repair-intent-1.json");
  const head = await stageMasterJournalCutover(master, { journalExists: true,
    journal: [{ id: "owned" }], archive: [], allocateVersion });
  wal.children.set("repair-intent-1.json", firstFile);
  (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...head, repairIntentId: firstId, repairIntentSequence: 1,
  }));
  assertEquals((await readMasterJournalHead(master)).repairIntentId, firstId);
  const sameIdPlan = await fingerprintMasterJournalRepairEvidence(master);
  await assertRejects(() => stageMasterJournalRepairIntent(master, {
    id: firstId, reason: "owner-repair", expectedEvidenceSha256: sameIdPlan.sha256,
  }), Error, "new ID", "a discharged ID may not be minted again for re-repair");
  assertEquals(wal.children.has("repair-intent-2.json"), false);
  await stageMasterJournalRepairIntent(master, { id: nextId, reason: "owner-repair",
    expectedEvidenceSha256: (await fingerprintMasterJournalRepairEvidence(master)).sha256 });
  assertEquals(firstFile.bytes, firstBytes, "old checked witness bytes stay append-only");
  assertEquals(wal.children.has("repair-intent-2.json"), true);
  await assertRejects(() => readMasterJournalHead(master), Error, "newer repair intent pending",
    "the old signed head cannot discharge the newer ID or reactivate legacy");
  const pendingPlan = await fingerprintMasterJournalRepairEvidence(master);
  await assertRejects(() => stageMasterJournalRepairIntent(master, {
    id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", reason: "owner-repair",
    expectedEvidenceSha256: pendingPlan.sha256,
  }), Error, "newer repair intent pending");
  assertEquals(wal.children.has("repair-intent-3.json"), false,
    "a pending re-repair cannot skip to another witness");
  const oldHead = await wal.getFileHandle("head-a.json");
  oldHead.bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...head, repairIntentId: nextId, repairIntentSequence: 2,
  }));
  await assertRejects(() => readMasterJournalHead(master), Error, "repair head did not advance",
    "a forged same-sequence head cannot discharge the newer intent");
});

Deno.test("reader refuses a forged checked re-repair chain that reuses an older witness ID", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const head = await stageMasterJournalCutover(master, { journalExists: true,
    journal: [{ id: "owned" }], archive: [], allocateVersion });
  const wal = await master.getDirectoryHandle("journal-wal");
  const id = "11111111-2222-4333-8444-555555555555";
  (await wal.getFileHandle("repair-intent-1.json", { create: true })).bytes =
    encoder.encode(await sealMasterJournalRecord("repair-intent", {
      schemaVersion: 1, sequence: 1, id, reason: "pre-head-residue",
      evidenceSha256: "a".repeat(64), requestedRepairRecords: [],
    }));
  (await wal.getFileHandle("repair-intent-2.json", { create: true })).bytes =
    encoder.encode(await sealMasterJournalRecord("repair-intent", {
      schemaVersion: 1, sequence: 2, id, reason: "owner-repair",
      evidenceSha256: "b".repeat(64), requestedRepairRecords: [], previousId: id,
      previousHead: { epoch: head.epoch, sequence: head.sequence, version: head.version },
    }));
  (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...head, repairIntentSequence: 1, repairIntentId: id,
  }));
  (await wal.getFileHandle("head-b.json", { create: true })).bytes =
    encoder.encode(await sealMasterJournalRecord("head", {
      ...head, sequence: head.sequence + 1, version: head.version + 1,
      repairIntentSequence: 2, repairIntentId: id,
    }));
  await assertRejects(() => readMasterJournalHead(master), Error, "repair intent chain or ID is reused");
});

Deno.test("a forged older head witness mismatch cannot hide behind a valid newer head", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const first = await stageMasterJournalCutover(master, { journalExists: true,
    journal: [{ id: "owned" }], archive: [], allocateVersion });
  const next = await stageMasterJournalFrame(master, { operation: "append", row: { id: "newer" } },
    { allocateVersion });
  const id = "11111111-2222-4333-8444-555555555555";
  await stageMasterJournalRepairIntent(master, { id, reason: "owner-repair",
    expectedEvidenceSha256: (await fingerprintMasterJournalRepairEvidence(master)).sha256 });
  const wal = await master.getDirectoryHandle("journal-wal");
  (await wal.getFileHandle("head-b.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...next, repairIntentSequence: 1, repairIntentId: id,
  }));
  (await wal.getFileHandle("head-a.json")).bytes = encoder.encode(await sealMasterJournalRecord("head", {
    ...first, repairIntentSequence: 1,
    repairIntentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  }));
  await assertRejects(() => readMasterJournalHead(master), Error, "older head repair witness mismatch");
  await assertRejects(() => readMasterJournalProjection(master), Error,
    "older head repair witness mismatch", "both present head slots must preserve exact identity");
});

Deno.test("failed repair-intent close leaves non-overwritable fail-closed evidence", async () => {
  const { master, legacy } = await legacyFixture({ close: "repair-intent-1.json" });
  const input = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", reason: "pre-head-residue",
    expectedEvidenceSha256: (await fingerprintMasterJournalRepairEvidence(master)).sha256 };
  await assertRejects(() => stageMasterJournalRepairIntent(master, input), Error, "injected close");
  await assertRejects(() => readMasterJournalHead(master), Error); // never activate stale legacy bytes
  const torn = (await (await master.getDirectoryHandle("journal-wal"))
    .getFileHandle("repair-intent-1.json")).bytes.slice();
  input.expectedEvidenceSha256 = (await fingerprintMasterJournalRepairEvidence(master)).sha256;
  await assertRejects(() => stageMasterJournalRepairIntent(master, input), Error);
  assertEquals((await (await master.getDirectoryHandle("journal-wal"))
    .getFileHandle("repair-intent-1.json")).bytes, torn, "retry cannot overwrite torn witness bytes");
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy);
});

Deno.test("legacy journal and archive evidence each enforce the per-file byte cap without WAL", async () => {
  const { master } = await legacyFixture();
  const journal = await master.getFileHandle("journal.json");
  const originalJournal = journal.bytes.slice();
  journal.bytes = encoder.encode("j".repeat(33));
  const tooLargeJournal = await snapshotMasterJournalRepairEvidence(master,
    { maxRecordBytes: 32, maxTotalBytes: 128 });
  assertEquals(tooLargeJournal.state, "inspection_refused");
  assertEquals(tooLargeJournal.refusals.includes("master journal repair evidence record exceeds byte limit"), true);
  assertEquals(journal.bytes.byteLength, 33);
  assertEquals(master.children.has("journal-wal"), false);
  journal.bytes = originalJournal;
  const archive = await master.getFileHandle("journal-archive.json", { create: true });
  archive.bytes = encoder.encode("a".repeat(33));
  const tooLargeArchive = await snapshotMasterJournalRepairEvidence(master,
    { maxRecordBytes: 32, maxTotalBytes: 128 });
  assertEquals(tooLargeArchive.state, "inspection_refused");
  assertEquals(tooLargeArchive.refusals.includes("master journal repair evidence record exceeds byte limit"), true);
  assertEquals(archive.bytes.byteLength, 33);
  assertEquals(journal.bytes, originalJournal);
  assertEquals(master.children.has("journal-wal"), false);
});

Deno.test("read-only owner repair evidence preserves pre-head residue and bounds its manifest", async () => {
  const { master, legacy, allocateVersion } = await legacyFixture();
  const absent = await snapshotMasterJournalRepairEvidence(master);
  assertEquals(absent.state, "legacy_empty_or_absent_wal");
  assertEquals(absent.legacy.journal.present, true);
  assertEquals(master.children.has("journal-wal"), false,
    "owner evidence reads must not create a missing WAL directory");
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  const residue = await wal.getFileHandle("checkpoint-18-0.json", { create: true });
  residue.bytes = encoder.encode("{torn");
  const before = residue.bytes.slice();
  const evidence = await snapshotMasterJournalRepairEvidence(master);
  assertEquals(evidence.state, "requires_explicit_owner_repair");
  assertEquals(evidence.authorityOutcomeRequired, true);
  assertEquals(evidence.actionable, false);
  assertEquals(evidence.candidates, []);
  assertEquals(evidence.records.map((r) => r.name), ["checkpoint-18-0.json"]);
  assertEquals(evidence.records[0].bytes, before.byteLength);
  assertEquals(/^[0-9a-f]{64}$/.test(evidence.records[0].sha256), true);
  assertEquals(evidence.legacy.journal.present, true);
  assertEquals(evidence.legacy.archive.present, false);
  assertEquals(evidence.legacy.journal.bytes, encoder.encode(legacy).byteLength);
  const legacyDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(legacy)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(evidence.legacy.journal.sha256, legacyDigest,
    "legacy evidence is a digest, never the raw row contents or an authority fallback");
  assertEquals(residue.bytes, before, "planning cannot alter a torn record");
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy);
  await assertRejects(() => readMasterJournalHead(master), Error, "pre-head residue");
  const limited = await snapshotMasterJournalRepairEvidence(master, { maxRecords: 0 });
  assertEquals(limited.records, []);
  assertEquals(limited.refusals.includes("master journal repair evidence record count exceeds limit"), true);
  const tooLarge = await snapshotMasterJournalRepairEvidence(master, { maxRecordBytes: 2 });
  assertEquals(tooLarge.records, []);
  assertEquals(tooLarge.refusals.includes("master journal repair evidence record exceeds byte limit"), true);
  const tooMuch = await snapshotMasterJournalRepairEvidence(master, { maxTotalBytes: 2 });
  assertEquals(tooMuch.records, []);
  assertEquals(tooMuch.refusals.includes("master journal repair evidence total bytes exceed limit"), true);
  await wal.getDirectoryHandle("unclassified", { create: true });
  const nested = await snapshotMasterJournalRepairEvidence(master);
  assertEquals(nested.records, []);
  assertEquals(nested.refusals.includes("master journal repair evidence has an unclassified directory or leaf"), true);
  await wal.removeEntry("unclassified"); // fake-only cleanup, planning itself never removes
  await wal.removeEntry("checkpoint-18-0.json"); // explicit fake-only cleanup
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "live" }],
    archive: [], allocateVersion });
  const published = await snapshotMasterJournalRepairEvidence(master);
  assertEquals(published.state, "current_head_checked");
  assertEquals(published.actionable, false,
    "a metadata snapshot cannot authorize quarantine of either published head's dependencies");
  assertEquals(published.candidates, []);
});

Deno.test("owner journal inspection describes corruption without selecting legacy fallback", async () => {
  const { master, allocateVersion } = await legacyFixture();
  assertEquals((await inspectMasterJournalForOwner(master)).state, "legacy_empty_or_absent_wal");
  const wal = await master.getDirectoryHandle("journal-wal", { create: true });
  assertEquals((await inspectMasterJournalForOwner(master)).state, "legacy_empty_or_absent_wal");
  await wal.getFileHandle("checkpoint-1-0.json", { create: true });
  const preHead = await inspectMasterJournalForOwner(master);
  assertEquals(preHead.state, "requires_explicit_owner_repair");
  assertEquals(preHead.reason.includes("pre-head residue"), true);
  await assertRejects(() => readMasterJournalHead(master), Error, "pre-head residue",
    "owner inspection must not change the product's fail-closed authority reader");
  await wal.removeEntry("checkpoint-1-0.json"); // explicit isolated-test repair, never an inspector side effect
  assertEquals((await inspectMasterJournalForOwner(master)).state, "legacy_empty_or_absent_wal");
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "owned" }],
    archive: [{ id: "historic" }], allocateVersion });
  const checked = await inspectMasterJournalForOwner(master);
  assertEquals(checked.state, "current_head_checked");
  assertEquals(checked.liveRows, 1);
  assertEquals(checked.archiveSegments, 1);
  assertEquals(checked.head.sequence, 0);
  assertEquals(checked.olderHeadReplayVerified, false,
    "inspection is not a full two-head export or restore validation");
  const archiveName = (await readMasterJournalHead(master)).archive;
  const archive = await wal.getFileHandle(archiveName);
  const archivedBytes = archive.bytes.slice();
  archive.bytes = encoder.encode("{torn");
  assertEquals((await inspectMasterJournalForOwner(master)).state, "requires_explicit_owner_repair",
    "a current archive-chain failure cannot be reported as a checked projection");
  archive.bytes = archivedBytes;
  assertEquals((await inspectMasterJournalForOwner(master)).state, "current_head_checked");
  (await wal.getFileHandle("head-b.json", { create: true })).bytes = encoder.encode("{torn");
  assertEquals((await inspectMasterJournalForOwner(master)).state, "requires_explicit_owner_repair");
  await assertRejects(() => readMasterJournalHead(master), Error);
});

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

Deno.test("cutover pre-head residue refuses stale legacy reads until explicit owner repair", async () => {
  const { master, allocateVersion } = await legacyFixture({ close: "checkpoint-18-0.json" });
  await assertRejects(() => stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: "legacy" }], archive: [], allocateVersion,
  }), Error, "injected close");
  await assertRejects(() => readMasterJournalHead(master), Error, "pre-head residue");
  await assertRejects(() => readMasterJournalProjection(master), Error, "pre-head residue");
  assertEquals((await master.getDirectoryHandle("journal-wal")).children.has("checkpoint-18-0.json"), true,
    "a failed cutover retains immutable evidence, not a legacy fallback decision");
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

Deno.test("failed archive publication preserves legacy bytes but refuses all pre-head progress", async () => {
  const faults = { close: "archive-18-0.json" };
  const { master, legacy, allocateVersion } = await legacyFixture(faults);
  await assertRejects(() => stageMasterJournalCutover(master, {
    journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion,
  }), Error, "injected close");
  assertEquals(decoder.decode((await master.getFileHandle("journal.json")).bytes), legacy,
    "legacy bytes survive for explicit owner repair, not automatic fallback");
  await assertRejects(() => readMasterJournalHead(master), Error, "pre-head residue");
  faults.close = null;
  await assertRejects(() => stageMasterJournalCutover(master,
    { journalExists: true, journal: [{ id: 1 }], archive: [], allocateVersion }),
  Error, "pre-head residue");
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
      faults.close = null;
      await assertRejects(() => stageMasterJournalFrame(master, {
        operation: "append", row: { id: "no-silent-torn-repair" },
      }, { allocateVersion, readIssuedVersion: async () => 999 }), Error, "unpublished");
      assertEquals((await readMasterJournalProjection(master)).head.sequence, 128);
    }
  }
});

Deno.test("staged WAL receipt compensation preserves absent vs present-empty existence", async () => {
  for (const exists of [false, true]) {
    const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
    await stageMasterJournalCutover(master, { journalExists: exists, journal: [], archive: [], allocateVersion });
    const receipt = await appendMasterJournalWithReceipt(master, {
      type: "task", executionId: `receipt-${exists}`,
    }, { allocateVersion, readIssuedVersion });
    assertEquals(receipt.wal.epoch, receipt.preState.epoch);
    assertEquals(receipt.wal.sequence, 1);
    assertEquals(receipt.wal.operationId, `${receipt.wal.epoch}:1`);
    const result = await compensateMasterJournalReceipt(master, receipt, { allocateVersion, readIssuedVersion });
    assertEquals(result.ok, true);
    const after = await readMasterJournalProjection(master);
    assertEquals(after.exists, exists);
    assertEquals(after.live, []);
  }
});

Deno.test("staged WAL receipt compensation survives compaction and preserves foreign rows", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  const receipt = await appendMasterJournalWithReceipt(master, {
    type: "task", executionId: "receipt-target",
  }, { allocateVersion, readIssuedVersion });
  assertEquals(receipt.wal.eviction, [seed[0]]);
  for (let i = 0; i < 127; i++) {
    await stageMasterJournalFrame(master, {
      operation: "append", row: { type: "foreign", executionId: `foreign-${i}` },
    }, { allocateVersion, readIssuedVersion });
  }
  const result = await compensateMasterJournalReceipt(master, receipt, { allocateVersion, readIssuedVersion });
  assertEquals(result.ok, true);
  assertEquals(result.concurrentRowsPreserved, true);
  const after = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(after.live, [...seed.slice(127), ...Array.from({ length: 127 }, (_, i) => ({ type: "foreign", executionId: `foreign-${i}` }))]);
  assertEquals(after.archive, seed.slice(0, 128), "archived evictions remain history, not a set of current live rows");
});

Deno.test("receipt compensation exports and restores both head slots and later compacted history", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  const receipt = await appendMasterJournalWithReceipt(master, { type: "task", executionId: "exported-compensation" },
    { allocateVersion, readIssuedVersion });
  for (let i = 0; i < 127; i++) await stageMasterJournalFrame(master, {
    operation: "append", row: { id: `foreign-${i}`, executionId: `foreign-${i}` },
  }, { allocateVersion });
  assertEquals((await compensateMasterJournalReceipt(master, receipt, { allocateVersion, readIssuedVersion })).ok, true);
  const snapshot = async () => {
    const wal = await master.getDirectoryHandle("journal-wal");
    const prefix = "memory/master/journal-wal/";
    const paths = new Map([...wal.children].map(([name, file]) => [prefix + name, file.bytes]));
    const selected = await selectPublishedMasterJournalBackupPaths([...paths.keys()], async (path) => ({
      size: paths.get(path).length, stream: new Blob([paths.get(path)]).stream(),
    }));
    assertEquals(await validateStagedMasterJournalBackup(
      selected.map((relPath) => ({ relPath, stagedPath: relPath })), async (path) => paths.get(path),
    ), true);
    const restored = new MemoryDir();
    const restoredWal = await restored.getDirectoryHandle("journal-wal", { create: true });
    for (const path of selected) {
      const name = path.slice(prefix.length);
      (await restoredWal.getFileHandle(name, { create: true })).bytes = paths.get(path).slice();
    }
    const expected = await readMasterJournalProjection(master, { includeArchive: true });
    const actual = await readMasterJournalProjection(restored, { includeArchive: true });
    assertEquals({ exists: actual.exists, live: actual.live, archive: actual.archive },
      { exists: expected.exists, live: expected.live, archive: expected.archive });
    return selected;
  };
  const first = await snapshot();
  assertEquals(first.some((path) => path.endsWith("frame-18-130.json")), true,
    "the post-compensation slot references its frame while the other slot retains the prior checkpoint");
  const rows = (await readMasterJournalProjection(master)).live;
  for (let i = 0; i < 127; i++) await stageMasterJournalFrame(master,
    { operation: "replace", rows }, { allocateVersion, readIssuedVersion });
  await stageMasterJournalFrame(master, { operation: "replace", rows }, { allocateVersion, readIssuedVersion });
  await snapshot();
});

Deno.test("absent receipt plus same-execution later rows restores absence, not present-empty", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: false, journal: [], archive: [], allocateVersion });
  const receipt = await appendMasterJournalWithReceipt(master,
    { type: "task", executionId: "same-exec" }, { allocateVersion, readIssuedVersion });
  await stageMasterJournalFrame(master, { operation: "append", row: {
    type: "prompt-attestation", executionId: "same-exec", receipt: "redacted",
  } }, { allocateVersion });
  assertEquals((await compensateMasterJournalReceipt(master, receipt,
    { allocateVersion, readIssuedVersion })).ok, true);
  const after = await readMasterJournalProjection(master);
  assertEquals(after.exists, false, "same-execution-only rows must not turn an absent key into present-empty");
  assertEquals(after.live, []);
});

Deno.test("receipt operation identity mismatch cannot authorize compensation", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: false, journal: [], archive: [], allocateVersion });
  const receipt = await appendMasterJournalWithReceipt(master,
    { type: "task", executionId: "identity-pinned" }, { allocateVersion, readIssuedVersion });
  const forged = structuredClone(receipt);
  forged.wal.operationId = `${forged.wal.epoch}:${forged.wal.sequence + 1}`;
  await assertRejects(() => compensateMasterJournalReceipt(master, forged, {
    allocateVersion, readIssuedVersion,
  }), Error, "invalid master journal compensation receipt");
  assertEquals((await readMasterJournalProjection(master)).version, receipt.writeVersion);
});

Deno.test("stale receipt from a replaced WAL epoch refuses before mutation", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: false, journal: [], archive: [], allocateVersion });
  const receipt = await appendMasterJournalWithReceipt(master, {
    type: "task", executionId: "old-enrollment",
  }, { allocateVersion, readIssuedVersion });
  master.children.delete("journal-wal"); // simulate owner-restored replacement generation, not ordinary clear
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "new-enrollment" }],
    archive: [], allocateVersion });
  const before = await readMasterJournalProjection(master);
  const refused = await compensateMasterJournalReceipt(master, receipt, { allocateVersion, readIssuedVersion });
  assertEquals(refused.reason, "generation_mismatch");
  assertEquals((await readMasterJournalProjection(master)).version, before.version);
  assertEquals((await readMasterJournalProjection(master)).live, [{ id: "new-enrollment" }]);
});

Deno.test("compensation frame and head faults never acknowledge partial mutation", async () => {
  for (const fault of ["frame-18-2.json", "head-a.json"]) {
    const faults = {};
    const { master, allocateVersion, readIssuedVersion } = await legacyFixture(faults);
    await stageMasterJournalCutover(master, { journalExists: false, journal: [], archive: [], allocateVersion });
    const receipt = await appendMasterJournalWithReceipt(master, {
      type: "task", executionId: "crash-compensate",
    }, { allocateVersion, readIssuedVersion });
    faults.close = fault;
    await assertRejects(() => compensateMasterJournalReceipt(master, receipt,
      { allocateVersion, readIssuedVersion }), Error, "injected close");
    if (fault.startsWith("frame")) {
      const projection = await readMasterJournalProjection(master);
      assertEquals(projection.head.sequence, 1);
      assertEquals(projection.live.at(-1).executionId, "crash-compensate");
    } else {
      await assertRejects(() => readMasterJournalProjection(master), Error, "corrupt");
    }
  }
});

Deno.test("staged WAL receipt refuses same-value ABA and guard undo retains historical eviction", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  const receipt = await appendMasterJournalWithReceipt(master, {
    type: "task", executionId: "receipt-aba",
  }, { allocateVersion, readIssuedVersion });
  await stageMasterJournalFrame(master, { operation: "replace", rows: receipt.postState }, { allocateVersion });
  const stale = await compensateMasterJournalReceipt(master, receipt, { allocateVersion, readIssuedVersion });
  assertEquals(stale.reason, "journal_version_mismatch");
  assertEquals((await readMasterJournalProjection(master)).live.at(-1).executionId, "receipt-aba");

  let calls = 0;
  await assertRejects(() => appendMasterJournalWithReceipt(master, {
    type: "task", executionId: "forbidden",
  }, { allocateVersion, readIssuedVersion, guard: async () => {
    if (++calls === 2) throw new Error("lost ownership");
  } }), Error, "lost ownership");
  const after = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(after.live.some((row) => row.executionId === "forbidden"), false);
  assertEquals(after.archive.length, 2, "the forbidden append's eviction remains historical residue");
});

Deno.test("ordinary no-receipt WAL append shares guarded live undo and historical eviction", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  let calls = 0;
  await assertRejects(() => appendMasterJournalRow(master,
    { type: "prompt-attestation", note: "forbidden" },
    { allocateVersion, readIssuedVersion, guard: async () => {
      if (++calls === 2) throw new Error("no-receipt guard refused");
    } }), Error, "no-receipt guard refused");
  const after = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(after.head.sequence, 2);
  assertEquals(after.live, seed, "the forbidden ordinary row is absent from the live projection");
  assertEquals(after.archive, [seed[0]], "its eviction remains immutable archive history");
  assertEquals(calls, 2);
});

Deno.test("ordinary WAL replay idempotency requires exact actual execution identity", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: false, journal: [], archive: [], allocateVersion });
  const issuer = { allocateVersion, readIssuedVersion, idempotencyExecutionId: "replayed" };
  const first = await appendMasterJournalRow(master,
    { type: "result", executionId: "replayed", result: "first" }, issuer);
  const before = await readMasterJournalHead(master);
  const repeated = await appendMasterJournalRow(master,
    { type: "result", executionId: "replayed", result: "changed" }, issuer);
  assertEquals(repeated, first, "replay cannot publish a second result frame");
  assertEquals(await readMasterJournalHead(master), before);
  await assertRejects(() => appendMasterJournalRow(master,
    { type: "result", executionId: "wrong" }, issuer), Error, "idempotency identity");
  assertEquals(await readMasterJournalHead(master), before);
});

Deno.test("post-compensation fence undo targets its actual issued token", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "pre" }],
    archive: [], allocateVersion });
  const receipt = await appendMasterJournalWithReceipt(master, {
    type: "task", executionId: "undo-compensation",
  }, { allocateVersion, readIssuedVersion });
  let calls = 0;
  const refused = await compensateMasterJournalReceipt(master, receipt, {
    allocateVersion, readIssuedVersion, guard: async () => {
      if (++calls === 2) await allocateVersion(); // unrelated master key issues a token
      if (calls === 3) throw new Error("lost fence after compensation");
    },
  });
  assertEquals(refused.reason, "journal_fence_failed");
  const after = await readMasterJournalProjection(master);
  assertEquals(after.live, receipt.postState, "failed compensation undoes only its own write");
  assertEquals(receipt.compensatedState, undefined, "failed compensation is not marked idempotent");
});

Deno.test("staged WAL cancellation commits a single bounded replacement with its eviction", async () => {
  const { master, allocateVersion, readIssuedVersion } = await legacyFixture();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  const rows = await cancelMasterJournalExecution(master, {
    result: "cancelled",
  }, "cancel-exec", { allocateVersion, readIssuedVersion });
  assertEquals(rows.length, 500);
  const after = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(after.live, rows);
  assertEquals(after.live.at(-1).type, "cancelled");
  assertEquals(after.archive, [seed[0]]);
  assertEquals(after.head.sequence, 1);
});

Deno.test("cancellation replacement archives its eviction in the same published frame", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  const old = await readMasterJournalProjection(master);
  await assertRejects(() => stageMasterJournalFrame(master, {
    operation: "replace", rows: [...seed.slice(1), { type: "cancelled" }], evicted: [{ id: "not-the-oldest" }],
  }, { allocateVersion, expectedVersion: old.version, expectedEpoch: old.head.epoch }),
  Error, "does not match the current oldest");
  assertEquals((await readMasterJournalProjection(master)).version, old.version, "invalid eviction cannot issue a token");
  await stageMasterJournalFrame(master, {
    operation: "replace", rows: [...seed.slice(1), { type: "cancelled" }], evicted: [seed[0]],
  }, { allocateVersion, expectedVersion: old.version, expectedEpoch: old.head.epoch });
  const projected = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projected.live, [...seed.slice(1), { type: "cancelled" }]);
  assertEquals(projected.archive, [seed[0]]);
  assertEquals(projected.head.sequence, old.head.sequence + 1);
});

Deno.test("post-compaction compensation preserves the archive history log and later foreign appends", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  await stageMasterJournalFrame(master, { operation: "append", row: { id: "target" } }, { allocateVersion });
  const postAppend = (await readMasterJournalProjection(master)).live;
  for (let i = 0; i < 127; i++) {
    await stageMasterJournalFrame(master, { operation: "replace", rows: postAppend }, { allocateVersion });
  }
  await stageMasterJournalFrame(master, { operation: "replace", rows: seed }, { allocateVersion });
  let projection = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projection.head.checkpointSequence, 129);
  assertEquals(projection.live, seed, "the evicted row is restored live after compaction");
  assertEquals(projection.archive, [seed[0]], "the same row remains in append-only history");
  await stageMasterJournalFrame(master, { operation: "append", row: { id: "foreign" } }, { allocateVersion });
  projection = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projection.live, [...seed.slice(1), { id: "foreign" }]);
  assertEquals(projection.archive, [seed[0], seed[0]], "a later re-eviction is a second history event");
});

Deno.test("post-commit guard undo restores live rows but keeps the eviction as history across compaction", async () => {
  const { master, allocateVersion } = await legacyFixture();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
  await stageMasterJournalFrame(master, { operation: "append", row: { id: "forbidden" } }, { allocateVersion });
  await stageMasterJournalFrame(master, { operation: "replace", rows: seed }, { allocateVersion });
  let projection = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projection.live, seed, "the forbidden row must not remain live");
  assertEquals(projection.archive, [seed[0]], "the abandoned eviction remains as archive history");
  for (let i = 0; i < 126; i++) {
    await stageMasterJournalFrame(master, { operation: "replace", rows: seed }, { allocateVersion });
  }
  await stageMasterJournalFrame(master, { operation: "replace", rows: seed }, { allocateVersion });
  projection = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(projection.head.checkpointSequence, 129);
  assertEquals(projection.live, seed);
  assertEquals(projection.archive, [seed[0]], "compaction seals, but must not resurrect, the historical eviction");
});

Deno.test("durable exact compaction issuance claim survives restart and stays out of backups", async () => {
  const faults = {};
  const { master, allocateVersion, readGeneration } = await legacyFixture(faults);
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed,
    archive: [], allocateVersion });
  const issuer = createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration });
  for (let i = 0; i < 128; i++) {
    await stageMasterJournalFrame(master, { operation: "append", row: { id: i } }, issuer);
  }
  faults.write = "head-b.json";
  await assertRejects(() => stageMasterJournalFrame(master,
    { operation: "append", row: { id: "after-compaction" } }, issuer), Error, "injected write");
  const wal = await master.getDirectoryHandle("journal-wal");
  const claim = await wal.getFileHandle("claim-18-129.json");
  assertEquals(claim.bytes.byteLength > 0, true);
  assertEquals((await readMasterJournalProjection(master)).head.sequence, 128);
  faults.write = null;
  const restartedIssuer = createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration });
  await stageMasterJournalFrame(master,
    { operation: "append", row: { id: "after-compaction" } }, restartedIssuer);
  const after = await readMasterJournalProjection(master, { includeArchive: true });
  assertEquals(after.head.checkpointSequence, 129);
  assertEquals(after.live.at(-1).id, "after-compaction");
  assertEquals(after.archive, seed.slice(0, 129), "both sealed and pending evictions survive exact claim adoption");
  assertEquals(wal.children.has("claim-18-129.json"), false,
    "once both checked heads pass the claim's sequence, retry evidence retires without removing journal authority");
  const prefix = "memory/master/journal-wal/";
  const paths = new Map([...wal.children].map(([name, file]) => [prefix + name, file.bytes]));
  const selected = await selectPublishedMasterJournalBackupPaths([...paths.keys()], async (path) => ({
    size: paths.get(path).length, stream: new Blob([paths.get(path)]).stream(),
  }));
  assertEquals(selected.includes(prefix + "claim-18-129.json"), false,
    "a claim is retry evidence, never published journal/backup authority");
  for (let id = 0; id < 127; id++) await stageMasterJournalFrame(master,
    { operation: "append", row: { id: `future-${id}` } }, restartedIssuer);
  assertEquals((await readMasterJournalProjection(master)).head.sequence, 257);
  await stageMasterJournalFrame(master,
    { operation: "append", row: { id: "future-compaction" } }, restartedIssuer);
  assertEquals(wal.children.has("claim-18-258.json"), false,
    "the second compaction claim retires once its subsequent frame advances the other head");
  const latest = await stageMasterJournalFrame(master,
    { operation: "append", row: { id: "future-retired" } }, restartedIssuer);
  assertEquals(latest.sequence, 260);
  assertEquals(wal.children.has("claim-18-258.json"), false);
  assertEquals((await readMasterJournalProjection(master, { includeArchive: true })).live.at(-1).id,
    "future-retired");
});

Deno.test("compensation forwards claim retirement and next-transaction preflight", async () => {
  const faults = {};
  const { master, allocateVersion, readGeneration } = await legacyFixture(faults);
  await stageMasterJournalCutover(master, { journalExists: true,
    journal: Array.from({ length: 500 }, (_, id) => ({ id })), archive: [], allocateVersion });
  const baseIssuer = createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration });
  let retirementAttempts = 0;
  const issuer = { ...baseIssuer, async retireClaims(head) {
    retirementAttempts++;
    return await baseIssuer.retireClaims(head);
  } };
  const receipt = await appendMasterJournalWithReceipt(master,
    { type: "task", executionId: "compensate-claim" }, issuer);
  for (let id = 500; id < 627; id++) await stageMasterJournalFrame(master,
    { operation: "append", row: { id, executionId: `foreign-${id}` } }, issuer);
  assertEquals((await readMasterJournalProjection(master)).head.sequence, 128);
  faults.remove = "claim-18-129.json";
  const attemptsBefore = retirementAttempts;
  assertEquals((await compensateMasterJournalReceipt(master, receipt, issuer)).ok, true,
    "compensation publishes once even when post-commit claim retirement fails");
  assertEquals(retirementAttempts, attemptsBefore + 1,
    "the compensation adapter must forward the issuer's post-publish retirement hook");
  const wal = await master.getDirectoryHandle("journal-wal");
  assertEquals(wal.children.has("claim-18-129.json"), true);
  const acknowledged = (await readMasterJournalProjection(master)).head.sequence;
  await assertRejects(() => appendMasterJournalWithReceipt(master,
    { type: "task", executionId: "later-claim" }, issuer), Error, "injected remove");
  assertEquals((await readMasterJournalProjection(master)).head.sequence, acknowledged);
  faults.remove = null;
  await cancelMasterJournalExecution(master,
    { type: "cancelled", executionId: "cancel-after-claim" }, "cancel-after-claim", issuer);
  assertEquals(wal.children.has("claim-18-129.json"), false);
});

Deno.test("staged receipt append and cancellation forward claim retirement hooks", async () => {
  for (const mode of ["append", "cancel"]) {
    const { master, allocateVersion, readGeneration } = await legacyFixture();
    await stageMasterJournalCutover(master, { journalExists: true,
      journal: Array.from({ length: 500 }, (_, id) => ({ id })), archive: [], allocateVersion });
    const baseIssuer = createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration });
    const wal = await master.getDirectoryHandle("journal-wal");
    let claimSeenBeforeRetirement = false;
    const issuer = { ...baseIssuer, async retireClaims(head) {
      if (head.checkpointSequence === 129 && head.sequence === 130) {
        claimSeenBeforeRetirement = wal.children.has("claim-18-129.json");
      }
      return await baseIssuer.retireClaims(head);
    } };
    for (let id = 500; id < 628; id++) await stageMasterJournalFrame(master,
      { operation: "append", row: { id } }, issuer);
    if (mode === "append") await appendMasterJournalWithReceipt(master,
      { type: "task", executionId: "claim-append" }, issuer);
    else await cancelMasterJournalExecution(master,
      { type: "cancelled", executionId: "claim-cancel" }, "claim-cancel", issuer);
    assertEquals(claimSeenBeforeRetirement, true,
      `${mode}: the claim must exist before the transaction retires it`);
    assertEquals(wal.children.has("claim-18-129.json"), false,
      `${mode}: compaction claim must retire after the transaction's frame advances both heads`);
  }
});

Deno.test("compaction is internal to the frame runner so claim retirement cannot be bypassed", async () => {
  const wal = await import("../extension/lib/master-journal-wal.js");
  assertEquals("stageMasterJournalCompaction" in wal, false);
});

Deno.test("failed claim retirement preserves acknowledged append then blocks the next mutation", async () => {
  const faults = {};
  const { master, allocateVersion, readGeneration } = await legacyFixture(faults);
  await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "base" }],
    archive: [], allocateVersion });
  const issuer = createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration });
  for (let id = 0; id < 128; id++) await stageMasterJournalFrame(master,
    { operation: "append", row: { id } }, issuer);
  faults.remove = "claim-18-129.json";
  const acknowledged = await stageMasterJournalFrame(master,
    { operation: "append", row: { id: 128 } }, issuer);
  assertEquals(acknowledged.sequence, 130, "retirement failure cannot make a published append look unacknowledged");
  assertEquals((await readMasterJournalProjection(master)).live.at(-1).id, 128);
  await assertRejects(() => stageMasterJournalFrame(master,
    { operation: "append", row: { id: 129 } }, issuer), Error, "injected remove");
  assertEquals((await readMasterJournalProjection(master)).head.sequence, 130);
  faults.remove = null;
  assertEquals((await stageMasterJournalFrame(master,
    { operation: "append", row: { id: 129 } }, issuer)).sequence, 131);
  assertEquals((await master.getDirectoryHandle("journal-wal")).children.has("claim-18-129.json"), false);
});

Deno.test("issuance refuses an incomplete source before burning a generation", async () => {
  const { master, allocateVersion, readGeneration } = await legacyFixture();
  const issuer = createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration });
  await assertRejects(() => issuer.allocateVersion({
    checkpoint: "checkpoint-18-1.json", source: { epoch: 18, throughFrame: 0 },
  }), Error, "invalid master journal compaction issuance claim");
  assertEquals(await readGeneration(), 17, "a malformed claim must not consume a durable token");
});

Deno.test("complete claim and archive without checkpoint retry with the exact claimed version", async () => {
  const faults = {};
  const { master, allocateVersion, readGeneration } = await legacyFixture(faults);
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await stageMasterJournalCutover(master, { journalExists: true, journal: seed,
    archive: [], allocateVersion });
  const issuer = createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration });
  for (let id = 500; id < 628; id++) await stageMasterJournalFrame(master,
    { operation: "append", row: { id } }, issuer);
  faults.create = "checkpoint-18-129.json";
  await assertRejects(() => stageMasterJournalFrame(master,
    { operation: "append", row: { id: 628 } }, issuer), Error, "injected create");
  const wal = await master.getDirectoryHandle("journal-wal");
  assertEquals(wal.children.has("claim-18-129.json"), true);
  assertEquals(wal.children.has("archive-18-1.json"), true);
  assertEquals(wal.children.has("checkpoint-18-129.json"), false);
  const claimVersion = (await unsealMasterJournalRecord(
    (await wal.getFileHandle("claim-18-129.json")).bytes, "claim")).version;
  const generationBeforeRetry = await readGeneration();
  faults.create = null;
  const recovered = await stageMasterJournalFrame(master,
    { operation: "append", row: { id: 628 } },
    createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration }));
  assertEquals(recovered.checkpointSequence, 129);
  assertEquals(await readGeneration(), generationBeforeRetry + 1,
    "the recovered append issues one frame token and no second compaction token");
  assertEquals((await unsealMasterJournalRecord(
    (await wal.getFileHandle("checkpoint-18-129.json")).bytes, "checkpoint")).version, claimVersion);
  assertEquals((await readMasterJournalProjection(master, { includeArchive: true })).archive, seed.slice(0, 129));
});

Deno.test("altered or torn durable compaction issuance claim refuses auto-repair", async () => {
  for (const mutant of ["wrong-version", "wrong-source", "torn", "torn-close"]) {
    const faults = {};
    const { master, allocateVersion, readGeneration } = await legacyFixture(faults);
    await stageMasterJournalCutover(master, { journalExists: true, journal: [{ id: "base" }],
      archive: [], allocateVersion });
    const issuer = createMasterJournalIssuer(master, { issueVersion: allocateVersion, readGeneration });
    for (let id = 0; id < 128; id++) await stageMasterJournalFrame(master,
      { operation: "append", row: { id } }, issuer);
    faults.write = mutant === "torn-close" ? null : "head-b.json";
    if (mutant === "torn-close") faults.close = "claim-18-129.json";
    await assertRejects(() => stageMasterJournalFrame(master,
      { operation: "append", row: { id: 128 } }, issuer), Error, mutant === "torn-close" ? "injected close" : "injected write");
    const claim = await (await master.getDirectoryHandle("journal-wal")).getFileHandle("claim-18-129.json");
    if (mutant === "wrong-version") await allocateVersion(); // a different master key advanced the global floor
    if (mutant === "wrong-version" || mutant === "wrong-source") {
      const payload = await unsealMasterJournalRecord(claim.bytes, "claim");
      claim.bytes = encoder.encode(await sealMasterJournalRecord("claim", mutant === "wrong-version"
        ? { ...payload, version: payload.version + 1 }
        : { ...payload, source: { ...payload.source, throughFrame: 127 } }));
    } else if (mutant === "torn") {
      claim.bytes = claim.bytes.slice(0, Math.floor(claim.bytes.length / 2));
    }
    faults.write = null;
    faults.close = null;
    await assertRejects(() => stageMasterJournalFrame(master,
      { operation: "append", row: { id: 128 } }, createMasterJournalIssuer(master,
        { issueVersion: allocateVersion, readGeneration })), Error,
      mutant === "wrong-version" ? "issued version mismatch" : "claim");
    assertEquals((await readMasterJournalProjection(master)).head.sequence, 128);
  }
});

Deno.test("complete equal compaction artifacts can be re-used only after verified pre-head crash", async () => {
  for (const tamper of [null, "checkpoint-rows", "checkpoint-source", "archive-rows", "unissued", "wrong-claimed", "no-witness"]) {
    const faults = {};
    const { master, allocateVersion, readIssuedVersion } = await legacyFixture(faults);
    const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
    await stageMasterJournalCutover(master, { journalExists: true, journal: seed, archive: [], allocateVersion });
    for (let id = 500; id < 628; id++) {
      await stageMasterJournalFrame(master, { operation: "append", row: { id } }, { allocateVersion });
    }
    faults.write = "head-b.json"; // old head-b exists; do not touch it before close
    await assertRejects(() => stageMasterJournalFrame(master, {
      operation: "append", row: { id: 628 },
    }, { allocateVersion, readIssuedVersion }), Error, "injected write");
    const wal = await master.getDirectoryHandle("journal-wal");
    const archive = await wal.getFileHandle("archive-18-1.json");
    const checkpoint = await wal.getFileHandle("checkpoint-18-129.json");
    assertEquals(archive.bytes.byteLength > 0 && checkpoint.bytes.byteLength > 0, true);
    const claim = { checkpoint: "checkpoint-18-129.json",
      source: (await unsealMasterJournalRecord(checkpoint.bytes, "checkpoint")).source };
    assertEquals((await readMasterJournalProjection(master)).head.sequence, 128);
    if (tamper === "checkpoint-rows" || tamper === "checkpoint-source") {
      const original = await unsealMasterJournalRecord(checkpoint.bytes, "checkpoint");
      checkpoint.bytes = encoder.encode(await sealMasterJournalRecord("checkpoint", tamper === "checkpoint-rows"
        ? { ...original, live: [{ id: "different-but-checksummed" }, ...original.live.slice(1)] }
        : { ...original, source: { ...original.source, throughFrame: original.source.throughFrame - 1 } }));
    } else if (tamper === "archive-rows") {
      const original = await unsealMasterJournalRecord(archive.bytes, "archive");
      archive.bytes = encoder.encode(await sealMasterJournalRecord("archive", {
        ...original, rows: [{ id: "different-but-checksummed" }],
      }));
    }
    faults.write = null;
    if (tamper) {
      const proof = tamper === "unissued" ? async () => 18
        : tamper === "wrong-claimed" ? async () => (await readIssuedVersion(claim)) + 1
        : tamper === "no-witness" ? undefined : readIssuedVersion;
      await assertRejects(() => stageMasterJournalFrame(master, {
        operation: "append", row: { id: 628 },
      }, { allocateVersion, readIssuedVersion: proof }), Error, "unpublished");
      assertEquals((await readMasterJournalProjection(master)).head.sequence, 128);
    } else {
      const beforeLog = dumpLogBuffer().entries.length;
      const next = await stageMasterJournalFrame(master, {
        operation: "append", row: { id: 628 },
      }, { allocateVersion, readIssuedVersion });
      assertEquals(next.checkpointSequence, 129);
      assertEquals((await readMasterJournalProjection(master, { includeArchive: true })).archive, seed.slice(0, 129));
      const adoptionLog = dumpLogBuffer().entries.slice(beforeLog)
        .filter((entry) => entry.ns === "master-journal-wal" && entry.msg.includes("verified compaction reuse"));
      assertEquals(adoptionLog.length, 2, "both adopted records appear in the bounded, redacted trace ring");
      assertEquals(adoptionLog.every((entry) => !entry.msg.includes("whole-archived")), true);
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
