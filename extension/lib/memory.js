// lib/memory.js — origin-keyed OPFS memory.
//
// Memory is the OPFS-backed store the agent reads/writes. Two tiers, both in
// the extension's OPFS origin (NOT shared with page origins):
//   - master memory  (the hub agent)  at memory/master/*
//   - per-site memory (sub-agents)    at memory/origins/<encoded-origin>/*
//
// One site origin must never access another's store: every per-site handle is
// keyed by the sanitized origin string and opened via a lookup that returns a
// distinct subdirectory per origin. Reads/writes go through these helpers so
// callers never touch another origin's handle.

const ROOT = "memory";

async function rootDir() {
  return await navigator.storage.getDirectory();
}

function encodeOrigin(origin) {
  // URL-safe, stable, reversible-ish key for an origin string.
  return encodeURIComponent(origin).replace(/%/g, "_");
}

/** Open (creating if needed) a directory handle for the given path segments. */
export async function openDir(segments) {
  let dir = await rootDir();
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
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

/** A single origin-scoped store. */
export function memoryStore(origin) {
  const path = origin === "master"
    ? ["memory", "master"]
    : ["memory", "origins", encodeOrigin(origin)];
  const isMaster = origin === "master";
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
      try { await dir.removeEntry(`${key}.json`); } catch { /* absent */ }
    },
    async clear() {
      const parent = await openDir(["memory"]);
      try { await parent.removeEntry(isMaster ? "master" : "origins"); } catch { /* absent */ }
    },
  };
}

export const masterMemory = () => memoryStore("master");
export const siteMemory = (origin) => memoryStore(origin);

/** Enumerate all enrolled site origins (the sub-agent directory). */
export async function listOrigins() {
  try {
    const dir = await openDir(["memory", "origins"]);
    const out = [];
    for await (const [name] of dir.entries()) out.push(decodeURIComponent(name.replace(/_/g, "%")));
    return out.sort();
  } catch {
    return [];
  }
}

// A small journal abstraction over a store (agent-do's memory pattern).
export async function journalAppend(store, entry) {
  const journal = (await store.get("journal")) ?? [];
  journal.push({ ts: Date.now(), ...entry });
  await store.set("journal", journal.slice(-500)); // cap per-origin journal
  return journal;
}
