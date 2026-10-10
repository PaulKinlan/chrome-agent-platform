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

export async function stageMasterJournalQuarantineCopy(master, { intentSequence, sourceName } = {}) {
  if (!Number.isSafeInteger(intentSequence) || intentSequence < 1 || intentSequence > 32 ||
      typeof sourceName !== "string") {
    throw new Error("master journal quarantine copy requires a checked intent sequence and source name");
  }
  const wal = await master.getDirectoryHandle("journal-wal");
  const intentBytes = await readBoundedBytes(await wal.getFileHandle(
    `repair-intent-${intentSequence}.json`), MAX_INTENT_BYTES);
  const intent = await unsealMasterJournalRecord(new TextDecoder().decode(intentBytes), "repair-intent");
  if (intent.sequence !== intentSequence) throw new Error("master journal quarantine intent sequence mismatch");
  const manifest = await deriveMasterJournalQuarantineManifest(intent);
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
