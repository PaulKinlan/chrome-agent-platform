// Validate the master-only WAL file set staged by a raw archive BEFORE an
// owner is asked to confirm restore. No writer is enabled by this adapter.
// An old backup without WAL files keeps the legacy journal.json authority.
import { classifyOpfsPath } from "./archive-target-registry.js";
import {
  readMasterJournalHead,
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
    const selected = (await readMasterJournalProjection(master(), { includeArchive: true })).head;
    const referenced = new Set();
    for (const name of HEADS) {
      if (!files.has(name)) continue;
      const bytes = await readFile(files.get(name));
      const head = await unsealMasterJournalRecord(bytes, "head");
      // The combined read already verified the selected generation; replay
      // only a distinct older slot (possibly referencing another checkpoint).
      if (JSON.stringify(head) !== JSON.stringify(selected)) {
        await readMasterJournalProjection(master(name), { includeArchive: true });
      }
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

// Head slots are small checked metadata, unlike potentially large whole-row
// checkpoints and archives. Bound an untrusted head before materializing it.
async function readHeadBytes(open, path) {
  const source = await open(path);
  if (!Number.isSafeInteger(source?.size) || source.size < 1 || source.size > 65536 ||
      typeof source.stream?.getReader !== "function") {
    throw new Error("master journal export head is missing, unbounded or unreadable");
  }
  const reader = source.stream.getReader();
  const bytes = new Uint8Array(source.size);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || size + value.byteLength > bytes.byteLength) {
        throw new Error("master journal export head exceeds its declared size");
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size !== bytes.byteLength) throw new Error("master journal export head is incomplete");
  return bytes;
}

/** Select only WAL files reachable from both checked head slots under the
 * caller's master-journal Web Lock. Do not export obsolete journal.json or
 * unacknowledged staging frames. The import validator verifies every selected
 * record's bytes; export never silently skips unknown WAL names/corrupt heads. */
export async function selectPublishedMasterJournalBackupPaths(paths, open) {
  const wal = new Map();
  for (const path of paths) {
    if (!path.startsWith(PREFIX)) continue;
    const leaf = path.slice(PREFIX.length);
    if (!leaf || leaf.includes("/") ||
        classifyOpfsPath(path).cls !== "portable-terminal-validated" || wal.has(leaf)) {
      throw new Error("master journal export contains an unclassified or repeated WAL record");
    }
    wal.set(leaf, path);
  }
  if (wal.size === 0) return paths;
  if (!wal.has(HEADS[0])) throw new Error("master journal export is missing its cutover head");
  const headBytes = new Map();
  for (const name of HEADS) {
    if (wal.has(name)) headBytes.set(name, await readHeadBytes(open, wal.get(name)));
  }
  const headDirectory = {
    async getFileHandle(name) {
      const bytes = headBytes.get(name);
      if (!bytes) throw absent(name);
      return { async getFile() { return { async arrayBuffer() { return bytes.slice().buffer; } }; } };
    },
  };
  await readMasterJournalHead({ async getDirectoryHandle(name) {
    if (name !== "journal-wal") throw absent(name);
    return headDirectory;
  } });
  const published = new Set();
  for (const [name, bytes] of headBytes) {
    const head = await unsealMasterJournalRecord(bytes, "head");
    published.add(name);
    published.add(head.checkpoint);
    published.add(head.archive);
    for (let sequence = head.checkpointSequence + 1; sequence <= head.sequence; sequence++) {
      if (sequence - head.checkpointSequence > 128) {
        throw new Error("master journal export head exceeds the bounded replay window");
      }
      published.add(`frame-${head.epoch}-${sequence}.json`);
    }
  }
  if ([...published].some((name) => !wal.has(name))) {
    throw new Error("master journal export is missing a published WAL record");
  }
  return paths.filter((path) => {
    if (path === "memory/master/journal.json" || path === "memory/master/journal-archive.json") return false;
    return !path.startsWith(PREFIX) || published.has(path.slice(PREFIX.length));
  });
}
