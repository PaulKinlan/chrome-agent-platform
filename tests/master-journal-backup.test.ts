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
