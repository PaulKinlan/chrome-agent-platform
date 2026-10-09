// @ts-nocheck — staging and streaming adapters are deliberately faultable.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  selectPublishedMasterJournalBackupPaths,
  validateStagedMasterJournalBackup,
} from "../extension/lib/master-journal-backup.js";
import { sealMasterJournalRecord } from "../extension/lib/master-journal-wal.js";

const ENCODER = new TextEncoder();
const PREFIX = "memory/master/journal-wal/";
async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODER.encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function chainFixture() {
  const epoch = 41;
  const checkpoint = `checkpoint-${epoch}-0.json`;
  const archives = [0, 1, 2].map((i) => `archive-${epoch}-${i}.json`);
  const paths = new Map();
  paths.set(`${PREFIX}${checkpoint}`, ENCODER.encode(await sealMasterJournalRecord("checkpoint", {
    epoch, sequence: 0, exists: true, live: [{ id: "live" }],
  })));
  let previous = null;
  let previousHash = null;
  for (const [index, name] of archives.entries()) {
    const sealed = await sealMasterJournalRecord("archive", {
      epoch, index, previous, previousHash, exists: true, rows: [{ id: index }],
    });
    paths.set(`${PREFIX}${name}`, ENCODER.encode(sealed));
    previous = name;
    previousHash = await hash(sealed);
  }
  const archive = archives.at(-1);
  const archiveHash = previousHash;
  const lastHash = await hash(JSON.stringify({ epoch, sequence: 0, checkpoint, archive, archiveHash }));
  paths.set(`${PREFIX}head-a.json`, ENCODER.encode(await sealMasterJournalRecord("head", {
    epoch, sequence: 0, checkpointSequence: 0, version: epoch,
    checkpoint, archive, archiveHash, lastHash,
  })));
  const residue = `${PREFIX}frame-${epoch}-1.json`;
  paths.set(residue, ENCODER.encode(await sealMasterJournalRecord("frame", { epoch, sequence: 1 })));
  paths.set("memory/master/journal.json", ENCODER.encode("stale legacy value"));
  return { paths, archives: archives.map((name) => `${PREFIX}${name}`), residue };
}

Deno.test("export refuses pre-head WAL residue instead of selecting legacy journal", async () => {
  const { paths } = await chainFixture();
  paths.delete(`${PREFIX}head-a.json`);
  await assertRejects(() => selectPublishedMasterJournalBackupPaths(
    [...paths.keys()], async (path) => ({
      size: paths.get(path).length, stream: new Blob([paths.get(path)]).stream(),
    }),
  ), Error, "missing its cutover head");
});

Deno.test("two head slots retain the union of old and compacted checkpoint/archive chains", async () => {
  const { paths, archives } = await chainFixture();
  paths.delete(`${PREFIX}frame-41-1.json`); // unpublished residue is not a head dependency
  const epoch = 41;
  const archive = `archive-${epoch}-3.json`;
  const predecessor = paths.get(archives.at(-1));
  const sealed = await sealMasterJournalRecord("archive", {
    epoch, index: 3, previous: `archive-${epoch}-2.json`, previousHash: await hash(new TextDecoder().decode(predecessor)),
    exists: true, rows: [{ id: "new-segment" }],
  });
  paths.set(`${PREFIX}${archive}`, ENCODER.encode(sealed));
  const archiveHash = await hash(sealed);
  const checkpoint = `checkpoint-${epoch}-1.json`;
  paths.set(`${PREFIX}${checkpoint}`, ENCODER.encode(await sealMasterJournalRecord("checkpoint", {
    epoch, sequence: 1, version: epoch + 1, exists: true, live: [{ id: "after-compaction" }],
  })));
  const lastHash = await hash(JSON.stringify({ epoch, sequence: 1, checkpoint, archive, archiveHash }));
  paths.set(`${PREFIX}head-b.json`, ENCODER.encode(await sealMasterJournalRecord("head", {
    epoch, sequence: 1, version: epoch + 1, checkpointSequence: 1,
    checkpoint, archive, archiveHash, lastHash,
  })));
  const selected = await selectPublishedMasterJournalBackupPaths([...paths.keys()], async (path) => ({
    size: paths.get(path).length, stream: new Blob([paths.get(path)]).stream(),
  }));
  assertEquals(selected.includes(`${PREFIX}checkpoint-${epoch}-0.json`), true);
  assertEquals(selected.includes(`${PREFIX}${checkpoint}`), true);
  assertEquals(selected.includes(`${PREFIX}${archive}`), true);
  for (const prior of archives) assertEquals(selected.includes(prior), true);
  const staged = selected.map((relPath) => ({ relPath, stagedPath: relPath }));
  assertEquals(await validateStagedMasterJournalBackup(staged, async (path) => paths.get(path)), true);
  await assertRejects(() => validateStagedMasterJournalBackup(
    staged.filter((entry) => entry.relPath !== `${PREFIX}checkpoint-${epoch}-0.json`),
    async (path) => paths.get(path),
  ), Error, "missing");
});

Deno.test("clear reset keeps old-slot chain only until both head slots advance", async () => {
  const { paths, archives } = await chainFixture();
  const epoch = 41;
  const newRoot = `archive-${epoch}-3.json`;
  const rootText = await sealMasterJournalRecord("archive", {
    epoch, index: 3, previous: null, previousHash: null, reset: true,
    exists: false, rows: [],
  });
  paths.set(`${PREFIX}${newRoot}`, ENCODER.encode(rootText));
  const archiveHash = await hash(rootText);
  const publish = async (slot, sequence) => {
    const checkpoint = `checkpoint-${epoch}-${sequence}.json`;
    const text = await sealMasterJournalRecord("checkpoint", {
      epoch, sequence, version: epoch + sequence, exists: false, live: [],
    });
    paths.set(`${PREFIX}${checkpoint}`, ENCODER.encode(text));
    const checkpointHash = await hash(text);
    const lastHash = await hash(JSON.stringify({
      epoch, sequence, checkpoint, archive: newRoot, archiveHash, checkpointHash,
    }));
    paths.set(`${PREFIX}${slot}`, ENCODER.encode(await sealMasterJournalRecord("head", {
      epoch, sequence, version: epoch + sequence, checkpointSequence: sequence,
      checkpoint, archive: newRoot, archiveHash, checkpointHash, lastHash,
    })));
  };
  const exportPaths = () => selectPublishedMasterJournalBackupPaths([...paths.keys()], async (path) => ({
    size: paths.get(path).length, stream: new Blob([paths.get(path)]).stream(),
  }));
  await publish("head-b.json", 1);
  const mixed = await exportPaths();
  for (const prior of archives) assertEquals(mixed.includes(prior), true, "old slot still owns prior archive");
  assertEquals(mixed.includes(`${PREFIX}${newRoot}`), true);
  assertEquals(await validateStagedMasterJournalBackup(
    mixed.map((relPath) => ({ relPath, stagedPath: relPath })), async (path) => paths.get(path),
  ), true);
  await publish("head-a.json", 2);
  const advanced = await exportPaths();
  for (const prior of archives) assertEquals(advanced.includes(prior), false, "retired chain is not exported");
  assertEquals(advanced.includes(`${PREFIX}checkpoint-${epoch}-0.json`), false);
  assertEquals(advanced.includes(`${PREFIX}${newRoot}`), true);
  assertEquals(await validateStagedMasterJournalBackup(
    advanced.map((relPath) => ({ relPath, stagedPath: relPath })), async (path) => paths.get(path),
  ), true);
});

Deno.test("raw export selects every chained archive segment and restore checks the exact generation", async () => {
  const { paths, archives, residue } = await chainFixture();
  const selected = await selectPublishedMasterJournalBackupPaths([...paths.keys()], async (path) => ({
    size: paths.get(path).length,
    stream: new Blob([paths.get(path)]).stream(),
  }));
  assertEquals(selected.includes(residue), false, "unpublished frame stays excluded");
  assertEquals(selected.includes("memory/master/journal.json"), false, "stale legacy journal stays excluded");
  for (const archive of archives) assertEquals(selected.includes(archive), true, `${archive} must travel with its head`);
  const staged = selected.map((relPath) => ({ relPath, stagedPath: relPath }));
  assertEquals(await validateStagedMasterJournalBackup(staged, async (path) => paths.get(path)), true);
  await assertRejects(() => validateStagedMasterJournalBackup(
    staged.filter((entry) => entry.relPath !== archives[1]), async (path) => paths.get(path),
  ), Error, "missing");
  await assertRejects(() => validateStagedMasterJournalBackup(
    [...staged, { relPath: residue, stagedPath: residue }], async (path) => paths.get(path),
  ), Error, "unpublished");
});
