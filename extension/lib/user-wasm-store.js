// Owner-uploaded bytes, not a tool registry or an execution/admission boundary.
// No size/count/import/memory/parse gates. Uploading never compiles or runs Wasm.
import { createSha256 } from "./pure.js";

export const USER_WASM_ROOT = "cap-user-wasm-v1";
const LOCK = "cap-user-wasm-store-v1";
const DIGEST = /^[0-9a-f]{64}$/u;
const META = /^([0-9a-f]{64})\.json$/u;
const DATA = /^([0-9a-f]{64})\.wasm$/u;
const DELETING = /^delete-([0-9a-f]{64})\.json$/u;
const PENDING = /^upload-[0-9a-f-]+\.wasm$/u;

function requireDigest(digest) {
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw new Error("Invalid user-wasm digest");
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
  await removeIfPresent(root, `${digest}.wasm`);
  await removeIfPresent(root, `delete-${digest}.json`);
}

function metadata(value, digest) {
  if (!value || value.version !== 1 || value.digest !== digest ||
      typeof value.name !== "string" || !value.name.trim() ||
      typeof value.description !== "string" ||
      !Number.isInteger(value.size) || value.size < 0 ||
      !Number.isFinite(value.addedAt)) {
    throw new Error(`Invalid stored metadata for user-wasm ${digest}`);
  }
  return {
    version: 1, digest, name: value.name, description: value.description,
    size: value.size, addedAt: value.addedAt,
  };
}

// All callers hold the same origin-wide Web Lock. A crashed writer cannot leave
// an incomplete upload visible. A durable delete intent is completed on reopen.
// Only directory entries + JSON are read here, never module contents.
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
      if (JSON.parse(text)?.digest !== deleting[1]) throw new Error("Invalid user-wasm delete intent");
      await finishDelete(root, deleting[1]);
      names.delete(`${deleting[1]}.json`);
      names.delete(`${deleting[1]}.wasm`);
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
    if (!names.has(`${record.digest}.wasm`)) {
      throw new Error(`Stored user-wasm bytes are missing: ${record.digest}`);
    }
    records.set(record.digest, record);
  }
  for (const name of names) {
    const match = DATA.exec(name);
    if (match && !records.has(match[1])) await removeIfPresent(root, name);
  }
  return records;
}

/** Settings and its dedicated Worker share this origin-private OPFS store.
 * Same bytes = one entry: re-upload updates name/description, retaining addedAt.
 * Same name + different bytes = separate entries, disambiguated by full digest.
 * File/Blob input stays file-backed; callers must NOT serialize it as JSON.
 */
export function createUserWasmStore({
  storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks,
  now = Date.now,
} = {}) {
  async function run(operation) {
    if (!storage?.getDirectory) throw new Error("OPFS storage is unavailable");
    if (!locks?.request) throw new Error("Web Locks are unavailable");
    return await locks.request(LOCK, async () => {
      const root = await (await storage.getDirectory()).getDirectoryHandle(USER_WASM_ROOT, { create: true });
      return await operation(root, await recover(root));
    });
  }
  return {
    async put({ file, name, description = "" }, { onProgress } = {}) {
      if (!(file instanceof Blob)) throw new TypeError("Choose a file to upload");
      if (typeof name !== "string" || !name.trim()) throw new Error("Enter a name for this file");
      if (typeof description !== "string") throw new TypeError("Description must be text");
      return await run(async (root, records) => {
        const temporary = `upload-${crypto.randomUUID()}.wasm`;
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
          if (!existing) await handle.move(`${digest}.wasm`);
          const record = {
            version: 1, digest, name, description, size,
            addedAt: existing?.addedAt ?? now(),
          };
          // Publication is LAST: readers never see metadata for partial bytes.
          await writeJson(root, `${digest}.json`, record);
          committed = true;
          return record;
        } finally {
          if (writer) await writer.abort().catch(() => {});
          await removeIfPresent(root, temporary).catch(() => {});
          if (!committed && digest && !existing) {
            await removeIfPresent(root, `${digest}.json`).catch(() => {});
            await removeIfPresent(root, `${digest}.wasm`).catch(() => {});
          }
        }
      });
    },
    async list() {
      return await run((_root, records) => [...records.values()].sort(
        (a, b) => b.addedAt - a.addedAt || a.digest.localeCompare(b.digest),
      ));
    },
    async getFile(digest) {
      requireDigest(digest);
      return await run(async (root, records) => {
        if (!records.has(digest)) throw new DOMException("Uploaded file not found", "NotFoundError");
        const file = await (await root.getFileHandle(`${digest}.wasm`)).getFile();
        if (file.size !== records.get(digest).size) throw new Error("Stored user-wasm size changed");
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
