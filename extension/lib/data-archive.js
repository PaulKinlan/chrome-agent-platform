// lib/data-archive.js — owner export/import of ALL agent data
// (chrome-agent-platform-ykb / CAP-FB-20260825-DATA-EXPORT-IMPORT-01).
//
// THE BUNDLE FORMAT CONTRACT (versioned — a change here bumps
// ARCHIVE_FORMAT_VERSION and keeps old-version parsing honest):
//
//   {
//     magic: "cap-export",            // literal; anything else is foreign
//     formatVersion: 1,               // integer; a mismatch is a typed refusal
//     exportedAt: <ms epoch>,
//     extensionVersion: "<semver>",
//     policy: { excluded: [<plain sentences>] },   // stated INSIDE the bundle
//     configuredProviders: [{ id, model, keyConfigured }],  // NEVER secrets
//     mcpServers: [{ name, transportType, url, hadAuthHeaders }],
//     kv: { "<chrome.storage.local key>": <value>, ... },   // sanitized
//     alarms: [{ name, scheduledTime?, periodInMinutes? }],
//     opfs: [{ path, encoding: "utf8"|"base64", data }],    // the whole tree
//     manifest: { kvKeys, opfsFiles, alarms, totalBytes }
//   }
//
// DESIGN (why storage-level, not entity-level): the extension's durable state
// is exactly chrome.storage.local + the OPFS memory tree (master, per-site,
// named-agent, background-agent stores, artifact bodies, durable runs) +
// scheduled alarms. A byte-faithful snapshot of those three surfaces restores
// agent identities, memories, threads, artifacts AND references with no
// semantic drift — the same guarantee the factory reset wipes, inverted.
//
// SECRET POLICY (hard): provider API keys and MCP auth headers are NEVER
// serialized. The bundle records WHICH providers were configured and WHICH
// MCP servers had auth headers — shapes, not values. chrome.storage.session,
// caches and ephemeral bridge nonces are excluded (rebuilt or meaningless
// off-profile).
//
// SECURITY POSTURE: export/import are OWNER-gesture service-worker routes
// (owner.export.all / owner.import.all). They are not and must never be
// registered in any model-callable tool catalog — a full memory export is a
// high-value exfiltration target (tests/data-archive.test.ts pins this).
//
// TRANSACTIONALITY: import is two-phase. Phase 1 validates the whole bundle
// and the target state (a non-empty target refuses without the explicit
// overwrite choice and is left untouched). Phase 2 applies everything, then
// verifies every restored byte by re-reading it; a mismatch throws with the
// exact item — never a silent partial restore.

const ENCODER = new TextEncoder();
const FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const m = new Map();
  for (let i = 0; i < B64_ALPHABET.length; i++) m.set(B64_ALPHABET[i], i);
  return m;
})();

export function b64Encode(bytes) {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < n ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < n ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

export function b64Decode(text) {
  const clean = String(text).replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (const ch of clean) {
    const v = B64_LOOKUP.get(ch);
    if (v === undefined) throw new ArchiveFormatError("archive-bad-encoding", `invalid base64 character in bundle`);
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (value >> bits) & 0xff;
    }
  }
  return out.slice(0, idx);
}

export const ARCHIVE_MAGIC = "cap-export";
export const ARCHIVE_FORMAT_VERSION = 1;
/** Named, honest ceilings — exceeding them is a typed refusal, never a silent
 * truncation. 512 MiB is far beyond any real profile today; the bound exists
 * so a runaway tree cannot hang the owner's tab building one giant string. */
export const MAX_ARCHIVE_OPFS_FILES = 100_000;
export const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;

export class ArchiveFormatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArchiveFormatError";
    this.code = code;
  }
}

/** KV keys that are EPHEMERAL coordination state — meaningless off-profile. */
const EPHEMERAL_KV_KEYS = new Set([
  "cap:webmcpBridgeNonces",
  "cap:webmcpSnapshotGate",
]);

/** Keys that must NEVER leave the profile (secret material). The bundle
 * carries a shape-only summary instead (configuredProviders/mcpServers). */
const SECRET_KV_KEYS = new Set([
  "providerConfig", // provider API keys live here
]);

/**
 * Root directory prefixes and path patterns for internal authority, secrets,
 * and transient execution state. These must NEVER leave the profile via export,
 * and must NEVER be accepted/overwritten via import.
 */
export const EXCLUDED_OPFS_PREFIXES = Object.freeze([
  "cache/",
  "chrome-agent-platform-private/",
  "wasm-tool-streams-v1/",
]);

export function isExcludedOpfsPath(path) {
  if (typeof path !== "string" || !path.length) return true;
  const normalized = path.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (normalized.includes("..")) return true;

  for (const prefix of EXCLUDED_OPFS_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized === prefix.slice(0, -1)) {
      return true;
    }
  }

  if (normalized.includes("owner-approval-hmac")) return true;
  if (normalized.includes("chrome-agent-platform-private")) return true;
  if (normalized.includes("wasm-tool-streams-v1")) return true;

  const rootSeg = normalized.split("/")[0];
  if (
    rootSeg.startsWith(".dist-stage-") ||
    rootSeg.startsWith(".staging") ||
    rootSeg.startsWith(".tmp") ||
    rootSeg === ".staging" ||
    rootSeg === ".tmp"
  ) {
    return true;
  }

  return false;
}

export const EXCLUSION_POLICY = Object.freeze([
  "provider API keys (the bundle records which providers were configured, never their secrets)",
  "MCP server auth headers (the bundle records which servers had them)",
  "session state (chrome.storage.session and in-memory coordination keys)",
  "rebuilt-on-demand caches (model catalogs and other cache trees)",
  "internal authority and secret files (owner-approval HMAC, private keys, and transient tool streams)",
]);

/**
 * Real-browser OPFS adapter over a root FileSystemDirectoryHandle (the
 * service worker passes `await navigator.storage.getDirectory()`; tests use
 * the in-memory fake). Paths are "/"-joined segments; directory traversal is
 * recursive, so the snapshot covers the ENTIRE tree the extension owns.
 */
export function createOpfsAdapter(rootHandle) {
  async function* walk(dir, prefix) {
    for await (const entry of dir.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "directory") yield* walk(entry, path);
      else yield { path, name: entry.name, handle: entry };
    }
  }
  async function resolveDir(path, { create }) {
    const segs = path.split("/").filter(Boolean);
    let dir = rootHandle;
    for (const seg of segs) dir = await dir.getDirectoryHandle(seg, { create });
    return dir;
  }
  async function resolveParentAndName(path, { create }) {
    const idx = path.lastIndexOf("/");
    const dirPath = idx >= 0 ? path.slice(0, idx) : "";
    const name = idx >= 0 ? path.slice(idx + 1) : path;
    const dir = dirPath ? await resolveDir(dirPath, { create }) : rootHandle;
    return { dir, name };
  }
  return {
    listFiles: async () => {
      const out = [];
      for await (const f of walk(rootHandle, "")) out.push(f.path);
      return out.sort();
    },
    readFile: async (path) => {
      const { dir, name } = await resolveParentAndName(path, { create: false });
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    writeFile: async (path, bytes) => {
      const { dir, name } = await resolveParentAndName(path, { create: true });
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    },
    removeFile: async (path) => {
      const { dir, name } = await resolveParentAndName(path, { create: false });
      await dir.removeEntry(name);
    },
  };
}

/** Real-browser alarms adapter over chrome.alarms (tests use the fake). */
export function createChromeAlarmsAdapter() {
  return {
    getAll: async () => (await chrome.alarms.getAll()) || [],
    create: async (name, info) => {
      await chrome.alarms.create(name, info);
    },
    clearAll: async () => {
      await chrome.alarms.clearAll();
    },
  };
}

/** Strip secrets and ephemera from a chrome.storage.local dump. Pure. */
export function sanitizeKvForExport(kv) {
  const out = {};
  for (const [key, value] of Object.entries(kv || {})) {
    if (SECRET_KV_KEYS.has(key)) continue;
    if (EPHEMERAL_KV_KEYS.has(key)) continue;
    if (key === "cap:mcpServers" && Array.isArray(value)) {
      // The mcpServers summary records WHICH servers had auth headers; the
      // header VALUES themselves never enter the bundle.
      out[key] = value.map((s) => {
        const copy = structuredClone(s);
        if (copy && typeof copy === "object" && copy.transport && typeof copy.transport === "object") {
          delete copy.transport.headers;
        }
        return copy;
      });
      continue;
    }
    out[key] = structuredClone(value);
  }
  return out;
}

function summarizeProviders(providerConfig) {
  const providers = providerConfig?.providers;
  if (!Array.isArray(providers)) return [];
  return providers
    .filter((p) => p && typeof p === "object")
    .map((p) => ({
      id: String(p.id ?? "unknown"),
      model: typeof p.model === "string" ? p.model : "",
      keyConfigured: typeof p.apiKey === "string" && p.apiKey.trim().length > 0,
    }));
}

function summarizeMcpServers(servers) {
  if (!Array.isArray(servers)) return [];
  return servers
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      name: String(s.name ?? "unnamed"),
      transportType: String(s.transport?.type ?? "unknown"),
      url: typeof s.transport?.url === "string" ? s.transport.url : "",
      hadAuthHeaders: !!(s.transport?.headers && Object.keys(s.transport.headers).length),
    }));
}

/**
 * Collect a storage-level snapshot. Backends are INJECTED (the service worker
 * passes the real chrome.storage/OPFS/alarms seams; tests pass fakes). A read
 * failure THROWS — a partial snapshot is never emitted.
 */
export async function collectExportData({ kvGet, opfs, alarms, maxOpfsFiles = MAX_ARCHIVE_OPFS_FILES, maxTotalBytes = MAX_ARCHIVE_TOTAL_BYTES }) {
  const rawKv = (await kvGet(null)) || {};
  const configuredProviders = summarizeProviders(rawKv.providerConfig);
  const mcpServers = summarizeMcpServers(rawKv["cap:mcpServers"]);
  const kv = sanitizeKvForExport(rawKv);

  const files = [];
  let totalBytes = 0;
  for (const path of await opfs.listFiles()) {
    if (isExcludedOpfsPath(path)) continue;
    const bytes = await opfs.readFile(path);
    files.push({ path, bytes });
    totalBytes += bytes.length;
  }

  const alarmList = await alarms.getAll();
  const alarmRecords = (Array.isArray(alarmList) ? alarmList : [])
    .filter((a) => a && typeof a.name === "string")
    .map((a) => {
      const rec = { name: a.name };
      if (typeof a.scheduledTime === "number") rec.scheduledTime = a.scheduledTime;
      if (typeof a.periodInMinutes === "number") rec.periodInMinutes = a.periodInMinutes;
      return rec;
    });

  return {
    kv,
    files,
    alarms: alarmRecords,
    configuredProviders,
    mcpServers,
    bounds: { maxOpfsFiles, maxTotalBytes },
    totalBytes,
  };
}

/** Serialize a snapshot into the bundle string (enforces the named bounds). */
export function buildArchive(snapshot, { extensionVersion = "unknown", now = () => Date.now() } = {}) {
  const bounds = snapshot.bounds || {};
  const maxFiles = bounds.maxOpfsFiles ?? MAX_ARCHIVE_OPFS_FILES;
  const maxBytes = bounds.maxTotalBytes ?? MAX_ARCHIVE_TOTAL_BYTES;
  if (snapshot.files.length > maxFiles) {
    throw new ArchiveFormatError(
      "archive-too-many-files",
      `the profile holds ${snapshot.files.length} stored files; the export bound is ${maxFiles} — nothing was silently dropped`,
    );
  }
  if (snapshot.totalBytes > maxBytes) {
    throw new ArchiveFormatError(
      "archive-too-large",
      `the profile holds ${snapshot.totalBytes} bytes; the export bound is ${maxBytes} bytes — nothing was silently dropped`,
    );
  }

  const opfsEntries = snapshot.files.map(({ path, bytes }) => {
    let data;
    let encoding;
    try {
      data = FATAL_DECODER.decode(bytes);
      encoding = "utf8";
    } catch {
      data = b64Encode(bytes);
      encoding = "base64";
    }
    return { path, encoding, data };
  });

  const kvJsonBytes = ENCODER.encode(JSON.stringify(snapshot.kv)).length;
  const archive = {
    magic: ARCHIVE_MAGIC,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt: now(),
    extensionVersion,
    policy: { excluded: [...EXCLUSION_POLICY] },
    configuredProviders: snapshot.configuredProviders,
    mcpServers: snapshot.mcpServers,
    kv: snapshot.kv,
    alarms: snapshot.alarms,
    opfs: opfsEntries,
    manifest: {
      kvKeys: Object.keys(snapshot.kv).length,
      opfsFiles: opfsEntries.length,
      alarms: snapshot.alarms.length,
      totalBytes: snapshot.totalBytes + kvJsonBytes,
    },
  };
  return JSON.stringify(archive);
}

/** Parse + validate a bundle. Any foreign/corrupt input is a typed refusal. */
export function parseArchive(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new ArchiveFormatError("archive-not-json", "the bundle is not valid JSON — it is corrupt or not a cap-export file");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArchiveFormatError("archive-bad-shape", "the bundle is not an object — it is not a cap-export file");
  }
  if (parsed.magic !== ARCHIVE_MAGIC) {
    throw new ArchiveFormatError("archive-bad-magic", `not a cap-export bundle (magic: ${JSON.stringify(parsed.magic)})`);
  }
  if (!Number.isInteger(parsed.formatVersion) || parsed.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveFormatError(
      "archive-bad-version",
      `bundle format version ${JSON.stringify(parsed.formatVersion)} is not supported (this build reads version ${ARCHIVE_FORMAT_VERSION})`,
    );
  }
  if (!parsed.kv || typeof parsed.kv !== "object" || Array.isArray(parsed.kv)) {
    throw new ArchiveFormatError("archive-bad-shape", "bundle kv section missing or malformed");
  }
  if (!Array.isArray(parsed.opfs)) {
    throw new ArchiveFormatError("archive-bad-shape", "bundle opfs section missing or malformed");
  }
  for (const entry of parsed.opfs) {
    if (!entry || typeof entry.path !== "string" || entry.path.includes("..")) {
      throw new ArchiveFormatError("archive-bad-shape", "bundle carries a malformed or escaping file path");
    }
    if (isExcludedOpfsPath(entry.path)) {
      throw new ArchiveFormatError(
        "archive-forbidden-target",
        `bundle carries an internal authority/secret/transient target: ${entry.path}`,
      );
    }
    if (entry.encoding !== "utf8" && entry.encoding !== "base64") {
      throw new ArchiveFormatError("archive-bad-shape", `bundle carries an unknown encoding for ${entry.path}`);
    }
  }
  if (!Array.isArray(parsed.alarms)) parsed.alarms = [];
  if (!Array.isArray(parsed.configuredProviders)) parsed.configuredProviders = [];
  if (!Array.isArray(parsed.mcpServers)) parsed.mcpServers = [];
  if (!parsed.policy || !Array.isArray(parsed.policy.excluded)) parsed.policy = { excluded: [...EXCLUSION_POLICY] };
  return parsed;
}

/**
 * Import a bundle into a target profile. Two-phase: validate + target check
 * first (nothing touched), then apply + verify. A non-empty target refuses
 * without `overwrite: true` — the owner's explicit choice.
 */
export async function importArchive(bundleText, { kvGet, kvSet, kvRemove, opfs, alarms, overwrite = false } = {}) {
  const parsed = parseArchive(bundleText);

  // Phase 1 — target state check BEFORE any mutation.
  const existingKv = (await kvGet(null)) || {};
  const existingKeys = Object.keys(existingKv);
  const existingFiles = (await opfs.listFiles()).filter((p) => !isExcludedOpfsPath(p));
  const existingAlarms = await alarms.getAll();
  if (!overwrite && (existingKeys.length || existingFiles.length || (existingAlarms || []).length)) {
    throw new Error(
      `import refused: the target profile is not empty (${existingKeys.length} settings keys, ${existingFiles.length} stored files, ${(existingAlarms || []).length} alarms) — nothing was touched without the explicit overwrite choice`,
    );
  }

  // Phase 2a — clear the target when the owner chose overwrite.
  if (overwrite) {
    for (const key of existingKeys) await kvRemove(key);
    for (const path of existingFiles) await opfs.removeFile(path);
    if ((existingAlarms || []).length) await alarms.clearAll();
  }

  // Phase 2b — apply the bundle.
  const kvEntries = Object.entries(parsed.kv);
  if (kvEntries.length) await kvSet(Object.fromEntries(kvEntries.map(([k, v]) => [k, structuredClone(v)])));

  const restoredFiles = [];
  for (const entry of parsed.opfs) {
    const bytes = entry.encoding === "utf8" ? ENCODER.encode(entry.data) : b64Decode(entry.data);
    await opfs.writeFile(entry.path, bytes);
    restoredFiles.push({ path: entry.path, bytes });
  }

  for (const alarm of parsed.alarms) {
    const info = {};
    if (typeof alarm.scheduledTime === "number") info.when = alarm.scheduledTime;
    if (typeof alarm.periodInMinutes === "number") info.periodInMinutes = alarm.periodInMinutes;
    await alarms.create(alarm.name, info);
  }

  // Phase 2c — verify EVERY restored byte by re-reading it (never a silent
  // partial restore).
  for (const { path, bytes } of restoredFiles) {
    const back = await opfs.readFile(path);
    if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) {
      throw new ArchiveFormatError("import-verify-failed", `restored file failed verification: ${path}`);
    }
  }
  const kvBack = (await kvGet(null)) || {};
  for (const [key, value] of kvEntries) {
    if (JSON.stringify(kvBack[key]) !== JSON.stringify(value)) {
      throw new ArchiveFormatError("import-verify-failed", `restored setting failed verification: ${key}`);
    }
  }

  return Object.freeze({
    ok: true,
    restored: Object.freeze({
      kvKeys: kvEntries.length,
      opfsFiles: restoredFiles.length,
      alarms: parsed.alarms.length,
    }),
    exclusions: Object.freeze([...parsed.policy.excluded]),
    reminders: Object.freeze({
      configuredProviders: parsed.configuredProviders,
      mcpServers: parsed.mcpServers,
      note: "provider API keys and MCP auth headers were never in this bundle — re-enter them in Settings",
    }),
  });
}
