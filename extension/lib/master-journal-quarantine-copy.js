// TEST/OWNER-REPAIR STAGING ONLY. Never imported by a product route. The caller
// must hold the master journal Web Lock and admission/restore fence; this helper
// neither obtains owner approval nor publishes a head or enables backup export.
// It makes an append-only byte-for-byte OPFS evidence copy. Original bytes stay.
import { deriveMasterJournalQuarantineManifest } from "./master-journal-quarantine-manifest.js";
import { unsealMasterJournalRecord } from "./master-journal-wal.js";

const MAX_INTENT_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

async function digest(bytes) {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...result].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBytes(handle, maxBytes) {
  const file = await handle.getFile();
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) {
    throw new Error("master journal quarantine evidence exceeds byte limit");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw new Error("master journal quarantine evidence changed during read");
  return bytes;
}

async function readCheckedIntent(wal, sequence) {
  let handle;
  try {
    handle = await wal.getFileHandle(`repair-intent-${sequence}.json`);
  } catch (error) {
    if (error?.name === "NotFoundError") throw new Error("master journal quarantine repair intent missing");
    throw error;
  }
  const bytes = await readBoundedBytes(handle, MAX_INTENT_BYTES);
  const intent = await unsealMasterJournalRecord(new TextDecoder().decode(bytes), "repair-intent");
  if (intent.sequence !== sequence) throw new Error("master journal quarantine intent sequence mismatch");
  return intent;
}

export async function stageMasterJournalQuarantineCopy(master, { intentSequence, sourceName } = {}) {
  if (!Number.isSafeInteger(intentSequence) || intentSequence < 1 || intentSequence > 32 ||
      typeof sourceName !== "string") {
    throw new Error("master journal quarantine copy requires a checked intent sequence and source name");
  }
  const wal = await master.getDirectoryHandle("journal-wal");
  const manifest = await deriveMasterJournalQuarantineManifest(await readCheckedIntent(wal, intentSequence));
  const entry = manifest.entries.find((row) => row.sourceName === sourceName);
  if (!entry) throw new Error("master journal quarantine source is not bound by the checked intent");
  const original = await readBoundedBytes(await wal.getFileHandle(sourceName), MAX_SOURCE_BYTES);
  if (original.byteLength !== entry.sourceBytes || await digest(original) !== entry.sourceSha256) {
    throw new Error("master journal quarantine source changed after the repair intent");
  }
  try {
    const existing = await wal.getFileHandle(entry.quarantineLeaf);
    const copy = await readBoundedBytes(existing, MAX_SOURCE_BYTES);
    if (copy.byteLength !== original.byteLength || await digest(copy) !== entry.sourceSha256 ||
        copy.some((byte, index) => byte !== original[index])) {
      throw new Error("master journal immutable quarantine copy is torn or mismatched");
    }
    return { quarantineLeaf: entry.quarantineLeaf, manifestSha256: manifest.sha256, reused: true };
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
  const destination = await wal.getFileHandle(entry.quarantineLeaf, { create: true });
  const writable = await destination.createWritable();
  try {
    await writable.write(original);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* Preserve torn file for explicit owner repair. */ }
    throw error;
  }
  const copy = await readBoundedBytes(destination, MAX_SOURCE_BYTES);
  if (copy.byteLength !== original.byteLength || await digest(copy) !== entry.sourceSha256 ||
      copy.some((byte, index) => byte !== original[index])) {
    throw new Error("master journal immutable quarantine copy readback mismatch");
  }
  return { quarantineLeaf: entry.quarantineLeaf, manifestSha256: manifest.sha256, reused: false };
}

/** Read-only forensic evidence, never owner approval or head publication. Check
 * all witnesses through the nominated sequence, not only the latest one. */
export async function inspectMasterJournalQuarantineRetentionForOwner(master,
    { lastIntentSequence } = {}) {
  if (!Number.isSafeInteger(lastIntentSequence) || lastIntentSequence < 1 ||
      lastIntentSequence > 32) throw new Error("master journal retention intent bound is invalid");
  const wal = await master.getDirectoryHandle("journal-wal");
  const expected = new Map();
  const manifests = [];
  const seenIds = new Set();
  let previousId = null;
  let totalBytes = 0;
  for (let sequence = 1; sequence <= lastIntentSequence; sequence++) {
    const intent = await readCheckedIntent(wal, sequence);
    if (seenIds.has(intent.id) || (sequence > 1 && intent.previousId !== previousId)) {
      throw new Error("master journal quarantine repair intent chain or ID reused");
    }
    seenIds.add(intent.id);
    previousId = intent.id;
    const manifest = await deriveMasterJournalQuarantineManifest(intent);
    manifests.push({ sequence, sha256: manifest.sha256 });
    for (const entry of manifest.entries) {
      totalBytes += entry.sourceBytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 64 * 1024 * 1024 ||
          expected.size >= 1024 || expected.has(entry.quarantineLeaf)) {
        throw new Error("master journal quarantine retention evidence exceeds bound or collides");
      }
      expected.set(entry.quarantineLeaf, entry);
      let handle;
      try { handle = await wal.getFileHandle(entry.quarantineLeaf); }
      catch (error) {
        if (error?.name === "NotFoundError") throw new Error("master journal quarantine retention copy missing");
        throw error;
      }
      const bytes = await readBoundedBytes(handle, MAX_SOURCE_BYTES);
      if (bytes.byteLength !== entry.sourceBytes || await digest(bytes) !== entry.sourceSha256) {
        throw new Error("master journal quarantine retention copy mismatched");
      }
    }
  }
  let leavesSeen = 0;
  for await (const [name] of wal.entries()) {
    if (++leavesSeen > 4096) throw new Error("master journal quarantine retention directory exceeds bound");
    if (name.startsWith("quarantine-") && !expected.has(name)) {
      throw new Error("master journal quarantine retention has unbound evidence");
    }
  }
  return { schemaVersion: 1, manifestSha256: manifests.at(-1).sha256,
    retentionSha256: await digest(new TextEncoder().encode(JSON.stringify(manifests))),
    copyCount: expected.size, actionable: false, candidates: [] };
}
