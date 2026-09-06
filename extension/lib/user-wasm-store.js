// Owner-uploaded bytes (Wasm modules, Python wheels, …) — not a tool registry
// or an execution/admission boundary. No size/count/import/memory/parse gates.
// Uploading never compiles or runs anything.
import { createSha256 } from "./pure.js";

export const OWNER_BLOBS_ROOT = "cap-owner-blobs-v1";
// Pre-v2 root ("cap-user-wasm-v1") still on disk for real owner data; migrated
// into OWNER_BLOBS_ROOT on first open, then removed. See migrateV1.
const V1_ROOT = "cap-user-wasm-v1";
const LOCK = "cap-owner-blob-store-v1";
const RECORD_VERSION = 2;
/** Closed set of blob kinds. ovfm (Python modules) extends this constant —
 * it is the only sanctioned way to add a kind. */
export const OWNER_BLOB_KINDS = Object.freeze(["wasm", "wheel"]);
const KINDS = new Set(OWNER_BLOB_KINDS);
const DIGEST = /^[0-9a-f]{64}$/u;
const META = /^([0-9a-f]{64})\.json$/u;
const DATA = /^([0-9a-f]{64})\.bin$/u;
const DELETING = /^delete-([0-9a-f]{64})\.json$/u;
const PENDING = /^upload-[0-9a-f-]+\.bin$/u;
const V1_PENDING = /^upload-[0-9a-f-]+\.wasm$/u;

function requireDigest(digest) {
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw new Error("Invalid blob digest");
  return digest;
}

async function removeIfPresent(root, name) {
  try { await root.removeEntry(name); }
  catch (error) { if (error?.name !== "NotFoundError") throw error; }
}

async function writeJson(root, name, value) {
  const writer = await (await root.getFileHandle(name, { create: true })).createWritable();
  try {
    await writer.write(JSON.stringify(value));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

async function finishDelete(root, digest) {
  await removeIfPresent(root, `${digest}.json`);
  await removeIfPresent(root, `${digest}.bin`);
  await removeIfPresent(root, `delete-${digest}.json`);
}

function metadata(value, digest) {
  if (!value || value.version !== RECORD_VERSION || value.digest !== digest ||
      !KINDS.has(value.kind) ||
      typeof value.name !== "string" || !value.name.trim() ||
      typeof value.description !== "string" ||
      !Number.isInteger(value.size) || value.size < 0 ||
      !Number.isFinite(value.addedAt)) {
    throw new Error(`Invalid stored metadata for blob ${digest}`);
  }
  return {
    version: RECORD_VERSION, digest, kind: value.kind, name: value.name,
    description: value.description, size: value.size, addedAt: value.addedAt,
  };
}

// v1 → v2 migration (chrome-agent-platform-m6x8). Runs on first open, inside
// the same origin Web Lock as every other operation, and is idempotent.
//
// MIGRATION CHOICE: MOVE/re-key per entry. Bytes are moved (a rename inside
// the origin's OPFS — never copied, never rewritten) into the neutral root
// with a .bin rename; a v2 metadata record is written; the v1 metadata file
// is removed LAST as the per-file commit point; the v1 directory itself is
// removed only after every entry.
//
// CRASH INVARIANT: after a crash at any point, an entry is either still a
// complete v1 entry (the next open re-migrates it) or a complete v2 entry
// (possibly with v1 residue — stale metadata — that the next open cleans).
// Never both listings, never neither: a crash after the bytes moved but
// before the v2 metadata was committed leaves the v1 metadata in place, and
// the retry finds the bytes under the v2 root and finishes from there.
//
// Owner bytes are only ever moved. Digest identity is preserved bit-for-bit.
// A v1 entry whose bytes are missing (and no v2 copy exists) fails CLOSED
// exactly the way v1 failed — it is never silently dropped.
async function migrateV1(parent, root) {
  let v1;
  try { v1 = await parent.getDirectoryHandle(V1_ROOT, { create: false }); }
  catch (error) { if (error?.name === "NotFoundError") return; throw error; }

  const names = new Set();
  for await (const [name, handle] of v1.entries()) {
    if (handle.kind === "file") names.add(name);
  }
  // Complete v1's durable delete intents and drop its crashed temporaries,
  // exactly as the v1 recover pass would have.
  for (const name of names) {
    const deleting = DELETING.exec(name);
    if (deleting) {
      const text = await (await (await v1.getFileHandle(name)).getFile()).text();
      if (!text) {
        // The intent file exists, but write/close never committed it.
        await removeIfPresent(v1, name);
        continue;
      }
      if (JSON.parse(text)?.digest !== deleting[1]) throw new Error("Invalid delete intent");
      await removeIfPresent(v1, `${deleting[1]}.json`);
      await removeIfPresent(v1, `${deleting[1]}.wasm`);
      await removeIfPresent(v1, name);
      names.delete(`${deleting[1]}.json`);
      names.delete(`${deleting[1]}.wasm`);
    } else if (V1_PENDING.test(name)) {
      await removeIfPresent(v1, name);
    }
  }
  for (const name of [...names]) {
    const match = META.exec(name);
    if (!match) continue;
    const digest = match[1];
    const text = await (await (await v1.getFileHandle(name)).getFile()).text();
    // An empty v1 metadata file is an unpublished v1 upload — drop it.
    if (!text) { await removeIfPresent(v1, name); names.delete(name); continue; }
    const v1record = JSON.parse(text);
    if (!v1record || v1record.version !== 1 || v1record.digest !== digest ||
        typeof v1record.name !== "string" || !v1record.name.trim() ||
        typeof v1record.description !== "string" ||
        !Number.isInteger(v1record.size) || v1record.size < 0 ||
        !Number.isFinite(v1record.addedAt)) {
      throw new Error(`Invalid stored metadata for blob ${digest}`);
    }
    const hasV1Bytes = names.has(`${digest}.wasm`);
    if (hasV1Bytes) {
      // MOVE, never copy — digest identity is preserved bit-for-bit.
      await (await v1.getFileHandle(`${digest}.wasm`)).move(root, `${digest}.bin`);
    } else {
      // Crash window: the bytes already moved, the v2 metadata is not yet
      // committed and the v1 metadata is still present. The bytes live under
      // the v2 root — finish from there (never "neither").
      try { await root.getFileHandle(`${digest}.bin`); }
      catch { throw new Error(`Stored blob bytes are missing: ${digest}`); }
    }
    await writeJson(root, `${digest}.json`, {
      version: RECORD_VERSION, digest, kind: "wasm",
      name: v1record.name, description: v1record.description,
      size: v1record.size, addedAt: v1record.addedAt,
    });
    await removeIfPresent(v1, `${digest}.wasm`); // residue from the crash window
    await removeIfPresent(v1, `${digest}.json`); // per-file commit point (LAST)
  }
  // Whole-root removal is the final step; a failure here only delays cleanup
  // to the next open (it is never load-bearing for correctness).
  await parent.removeEntry(V1_ROOT, { recursive: true }).catch(() => {});
}

// All callers hold the same origin-wide Web Lock. A crashed writer cannot leave
// an incomplete upload visible. A durable delete intent is completed on reopen.
// Only directory entries + JSON are read here, never blob contents.
async function recover(root) {
  const names = new Set();
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "file") names.add(name);
  }
  for (const name of names) {
    const deleting = DELETING.exec(name);
    if (deleting) {
      const text = await (await (await root.getFileHandle(name)).getFile()).text();
      if (!text) {
        // The new intent file exists, but write/close never committed it.
        await removeIfPresent(root, name);
        continue;
      }
      if (JSON.parse(text)?.digest !== deleting[1]) throw new Error("Invalid delete intent");
      await finishDelete(root, deleting[1]);
      names.delete(`${deleting[1]}.json`);
      names.delete(`${deleting[1]}.bin`);
    } else if (PENDING.test(name)) {
      await removeIfPresent(root, name);
    }
  }
  const records = new Map();
  for (const name of names) {
    const match = META.exec(name);
    if (!match) continue;
    const text = await (await (await root.getFileHandle(name)).getFile()).text();
    // getFileHandle(create:true) creates an empty file BEFORE writable.close.
    // Empty metadata is an unpublished new upload, not a committed record.
    if (!text) {
      await removeIfPresent(root, name);
      names.delete(name);
      continue;
    }
    const record = metadata(JSON.parse(text), match[1]);
    if (!names.has(`${record.digest}.bin`)) {
      throw new Error(`Stored blob bytes are missing: ${record.digest}`);
    }
    records.set(record.digest, record);
  }
  for (const name of names) {
    const match = DATA.exec(name);
    if (match && !records.has(match[1])) await removeIfPresent(root, name);
  }
  return records;
}

/** Settings and its dedicated Worker share this origin-private OPFS store for
 * owner-supplied blobs of any supported kind (Wasm modules, Python wheels…).
 * Same bytes = one entry: re-upload updates name/description, retaining addedAt.
 * Same name + different bytes = separate entries, disambiguated by full digest.
 * File/Blob input stays file-backed; callers must NOT serialize it as JSON.
 * `bytes` is accepted as an alternative to `file` so an installer holding
 * bytes in memory need not wrap them first.
 */
export function createOwnerBlobStore({
  storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks,
  now = Date.now,
} = {}) {
  async function run(operation) {
    if (!storage?.getDirectory) throw new Error("OPFS storage is unavailable");
    if (!locks?.request) throw new Error("Web Locks are unavailable");
    return await locks.request(LOCK, async () => {
      const parent = await storage.getDirectory();
      const root = await parent.getDirectoryHandle(OWNER_BLOBS_ROOT, { create: true });
      await migrateV1(parent, root);
      return await operation(root, await recover(root));
    });
  }
  return {
    async put({ file, bytes, name, description = "", kind = "wasm" }, { onProgress } = {}) {
      if (!(file instanceof Blob) && (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {
        file = new Blob([bytes]); // ref-backed wrapper; no whole-file copy
      }
      if (!(file instanceof Blob)) throw new TypeError("Choose a file to upload");
      if (!KINDS.has(kind)) throw new TypeError(`Unknown blob kind: ${JSON.stringify(kind)}`);
      if (typeof name !== "string" || !name.trim()) throw new Error("Enter a name for this file");
      if (typeof description !== "string") throw new TypeError("Description must be text");
      return await run(async (root, records) => {
        const temporary = `upload-${crypto.randomUUID()}.bin`;
        const handle = await root.getFileHandle(temporary, { create: true });
        let writer, digest, existing, committed = false;
        try {
          writer = await handle.createWritable();
          const hash = createSha256();
          let size = 0;
          for await (const chunk of file.stream()) {
            hash.update(chunk);
            await writer.write(chunk);
            size += chunk.byteLength;
            onProgress?.(size, file.size);
          }
          if (size !== file.size) throw new Error("The selected file changed while uploading; choose it again");
          await writer.close();
          writer = null;
          digest = hash.hex();
          existing = records.get(digest);
          if (!existing) await handle.move(`${digest}.bin`);
          const record = {
            version: RECORD_VERSION, digest, kind, name, description, size,
            addedAt: existing?.addedAt ?? now(),
          };
          // Publication is LAST: readers never see metadata for partial bytes.
          await writeJson(root, `${digest}.json`, record);
          committed = true;
          // Explicit replacement signal (9ux7.1 R3): the caller never infers
          // it. Not part of the stored metadata — a property of THIS put.
          return { ...record, replaced: Boolean(existing), previousName: existing?.name ?? null };
        } finally {
          if (writer) await writer.abort().catch(() => {});
          await removeIfPresent(root, temporary).catch(() => {});
          if (!committed && digest && !existing) {
            await removeIfPresent(root, `${digest}.json`).catch(() => {});
            await removeIfPresent(root, `${digest}.bin`).catch(() => {});
          }
        }
      });
    },
    async list() {
      return await run((_root, records) => [...records.values()].sort(
        (a, b) => b.addedAt - a.addedAt || a.digest.localeCompare(b.digest),
      ));
    },
    // Named getFile for the File reference it returns (9ux7.1 asked for
    // "get"; the bead-vs-code naming difference is deliberate — bytes never
    // ride messaging JSON, only a File handle does).
    async getFile(digest) {
      requireDigest(digest);
      return await run(async (root, records) => {
        if (!records.has(digest)) throw new DOMException("Stored file not found", "NotFoundError");
        const file = await (await root.getFileHandle(`${digest}.bin`)).getFile();
        if (file.size !== records.get(digest).size) throw new Error("Stored blob size changed");
        return file; // File reference, not an arrayBuffer or JSON payload.
      });
    },
    async remove(digest) {
      requireDigest(digest);
      return await run(async (root) => {
        // Commit intent before deleting either half, so retries/restarts finish.
        await writeJson(root, `delete-${digest}.json`, { digest });
        await finishDelete(root, digest);
      });
    },
  };
}
