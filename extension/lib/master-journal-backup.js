// Validate the master-only WAL file set staged by a raw archive BEFORE an
// owner is asked to confirm restore. No writer is enabled by this adapter.
// An old backup without WAL files keeps the legacy journal.json authority.
import { classifyOpfsPath } from "./archive-target-registry.js";
import {
  readMasterJournalProjection,
  unsealMasterJournalRecord,
} from "./master-journal-wal.js";

const PREFIX = "memory/master/journal-wal/";
const HEADS = ["head-a.json", "head-b.json"];

function absent(name) {
  return new DOMException(`master journal backup file ${name} is missing`, "NotFoundError");
}

/** `entries` are archive-staged {relPath,stagedPath}; readFile reads staged
 * bytes. Every published head and the exact files it references must travel
 * together. Extra/unpublished frames and truncated/missing records refuse
 * before the archive can touch a live profile. */
export async function validateStagedMasterJournalBackup(entries, readFile) {
  const files = new Map();
  for (const entry of entries) {
    if (!entry.relPath.startsWith(PREFIX)) continue;
    const leaf = entry.relPath.slice(PREFIX.length);
    if (!leaf || leaf.includes("/") ||
        classifyOpfsPath(entry.relPath).cls !== "portable-terminal-validated" ||
        files.has(leaf)) {
      throw new Error("master journal backup contains an unclassified or repeated WAL record");
    }
    files.set(leaf, entry.stagedPath);
  }
  if (files.size === 0) return false;
  if (typeof readFile !== "function") throw new Error("master journal backup requires staged file reads");
  if (!files.has(HEADS[0])) throw new Error("master journal backup has no cutover head");

  const directory = (chosenHead = null) => ({
    async getFileHandle(name) {
      const sourceName = chosenHead && name === HEADS[0] ? chosenHead : name;
      if (chosenHead && name === HEADS[1]) throw absent(name);
      const stagedPath = files.get(sourceName);
      if (!stagedPath) throw absent(name);
      return {
        async getFile() {
          const bytes = await readFile(stagedPath);
          if (!(bytes instanceof Uint8Array)) throw new Error("master journal backup staged bytes are unreadable");
          return { async arrayBuffer() { return bytes.slice().buffer; } };
        },
      };
    },
  });
  const master = (chosenHead = null) => ({
    async getDirectoryHandle(name) {
      if (name !== "journal-wal") throw absent(name);
      return directory(chosenHead);
    },
  });

  try {
    // The combined read detects conflicting slots; per-slot projections verify
    // both generations even if compaction gave them different checkpoints.
    await readMasterJournalProjection(master(), { includeArchive: true });
    const referenced = new Set();
    for (const name of HEADS) {
      if (!files.has(name)) continue;
      await readMasterJournalProjection(master(name), { includeArchive: true });
      const bytes = await readFile(files.get(name));
      const head = await unsealMasterJournalRecord(bytes, "head");
      referenced.add(name);
      referenced.add(head.checkpoint);
      referenced.add(head.archive);
      for (let sequence = head.checkpointSequence + 1; sequence <= head.sequence; sequence++) {
        referenced.add(`frame-${head.epoch}-${sequence}.json`);
      }
    }
    if (files.size !== referenced.size || [...files.keys()].some((name) => !referenced.has(name))) {
      throw new Error("master journal backup contains unpublished or missing WAL records");
    }
  } catch (error) {
    throw new Error(`master journal backup is not a coherent checked generation: ${error?.message ?? error}`);
  }
  return true;
}
