// lib/memory.js — origin-keyed OPFS memory.
//
// Memory is the OPFS-backed store the agent reads/writes. Two tiers, both in
// the extension's OPFS origin (NOT shared with page origins):
//   - master memory  (the hub agent)  at memory/master/*
//   - per-site memory (sub-agents)    at memory/origins/<encoded-origin>/*
//
// One site origin must never access another's store: every per-site handle is
// keyed by the canonical origin string and opened via a lookup that returns a
// distinct subdirectory per origin. Reads/writes go through these helpers so
// callers never touch another origin's handle.

const ROOT = "memory";
const MASTER = "master";

/** Canonicalize an origin string (https://example.com:443 → https://example.com). */
export function canonicalOrigin(value) {
  try {
    const u = new URL(String(value));
    // Only http/https origins are supported; anything else (file:, data:,
    // about:, chrome-extension:) has a shared "null" or non-web origin that
    // must never be a storage boundary.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Injective, reversible encoding of a canonical origin for a directory name.
 * encodeURIComponent is injective (every byte maps to a unique escape sequence)
 * and reversible; no lossy substitutions.
 */
function encodeOrigin(origin) {
  return encodeURIComponent(origin);
}

function decodeOrigin(encoded) {
  return decodeURIComponent(encoded);
}

/** Open (creating if needed) a directory handle for the given path segments. */
export async function openDir(segments) {
  let dir = await rootDir();
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

async function rootDir() {
  return await navigator.storage.getDirectory();
}

async function readJson(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}

async function writeJson(dir, name, value) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(value));
  await w.close();
}

/** A single origin-scoped store. `origin` is a canonical origin string or "master". */
export function memoryStore(origin) {
  const isMaster = origin === MASTER;
  // Guard: a site origin can never collide with the reserved master sentinel.
  const path = isMaster
    ? [ROOT, MASTER]
    : [ROOT, "origins", encodeOrigin(origin)];
  return {
    isMaster,
    origin,
    async get(key) {
      const dir = await openDir(path);
      return await readJson(dir, `${key}.json`);
    },
    async set(key, value) {
      const dir = await openDir(path);
      await writeJson(dir, `${key}.json`, value);
    },
    async keys() {
      const dir = await openDir(path);
      const out = [];
      for await (const [name] of dir.entries()) {
        if (name.endsWith(".json")) out.push(name.slice(0, -5));
      }
      return out.sort();
    },
    async delete(key) {
      const dir = await openDir(path);
      try {
        await dir.removeEntry(`${key}.json`);
      } catch { /* absent */ }
    },
    async clear() {
      if (isMaster) {
        const parent = await openDir([ROOT]);
        try {
          await parent.removeEntry(MASTER, { recursive: true });
        } catch { /* absent */ }
        return;
      }
      // Remove ONLY this origin's subdirectory — never the whole origins tree.
      const origins = await openDir([ROOT, "origins"]);
      try {
        await origins.removeEntry(encodeOrigin(origin), { recursive: true });
      } catch { /* absent */ }
    },
  };
}

export const masterMemory = () => memoryStore(MASTER);

/** siteMemory accepts a raw origin string; it is canonicalized before use. */
export function siteMemory(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) {
    // Return a store that refuses to work on an invalid origin.
    const invalid = memoryStore(`invalid:${origin}`);
    return {
      ...invalid,
      async get() {
        return null;
      },
      async set() {
        throw new Error(`invalid origin: ${origin}`);
      },
    };
  }
  return memoryStore(canonical);
}

/** Enumerate all enrolled site origins (the sub-agent directory).
 * Derived from AUTHORITATIVE enrollment state (the master-memory origins list
 * maintained by enrollOrigin/disenrollOrigin), NOT from OPFS directory
 * existence. A delayed write that recreates an OPFS directory after a delete
 * must never resurrect a worker in the listing (the round-13 delete race). */
export async function listOrigins() {
  const origins = await masterMemory().get("origins");
  return Array.isArray(origins) ? origins : [];
}

// A small journal abstraction over a store (agent-do's memory pattern).
export async function journalAppend(store, entry) {
  const journal = (await store.get("journal")) ?? [];
  journal.push({ ts: Date.now(), ...entry });
  await store.set("journal", journal.slice(-500)); // cap per-origin journal
  return journal;
}
