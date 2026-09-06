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
// TRANSACTIONALITY: import is phased. Phase 1 validates the whole bundle
// DEEPLY (every entry decoded, every path classified, the manifest cross-
// checked) and the target state (a non-empty target refuses without the
// explicit overwrite choice and is left untouched). Phase 2 applies
// WRITE-BEFORE-WIPE under a durable sidecar journal ("cap:importBackup"):
// bundle content is written and byte-verified BEFORE any pre-existing state
// is destroyed, so an injected failure or an MV3 worker death mid-apply is
// recoverable to a byte-identical original (recoverPendingImport — run at
// import entry and on every worker boot). Only after full verification does
// the commit prune delete pre-existing state the bundle does not carry; a
// failure after that commit point leaves the complete verified bundle plus
// possibly stale extras — loss-free, cleaned by the next import.

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
  // b64Encode never emits a clean length ≡1 mod 4, so a bundle that does was
  // damaged — refuse it here (at parse) instead of decoding an empty/wrong
  // buffer after the import has already started mutating the profile.
  if (clean.length % 4 === 1) throw new ArchiveFormatError("archive-bad-encoding", "invalid base64 length in bundle");
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

/** The reserved KV key of the import-recovery journal. A bundle writing it
 * could clobber or impersonate a live journal. */
const IMPORT_SIDECAR_KEY = "cap:importBackup";

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** {scheduledTime?, periodInMinutes?} → {when?, periodInMinutes?} (chrome.alarms shape). */
function alarmRecInfo(rec) {
  const info = {};
  if (typeof rec.scheduledTime === "number") info.when = rec.scheduledTime;
  if (typeof rec.periodInMinutes === "number") info.periodInMinutes = rec.periodInMinutes;
  return info;
}

/** Segment-wise path classification for bundle opfs entries. A path is legal
 * iff every "/"-segment is non-empty and not "." or ".." (no traversal, no
 * absolute/double-slash/trailing-slash smuggling), carries no NUL, and does
 * not write into the reserved recovery namespace. */
function validateOpfsPath(path) {
  const segs = typeof path === "string" ? path.split("/") : [];
  if (typeof path !== "string" || path.includes("\0") || segs.some((s) => !s.length || s === "." || s === "..")) {
    throw new ArchiveFormatError("archive-bad-shape", "bundle carries a malformed or escaping file path");
  }
  if (segs[0] === "cap-import-backup") {
    throw new ArchiveFormatError("archive-bad-shape", "reserved recovery path in bundle");
  }
}

/** Reject lone surrogates (paired-aware): ENCODER.encode would silently turn
 * them into U+FFFD, so restored bytes would differ from the original file. */
function assertNoLoneSurrogates(str) {
  const bad = () => new ArchiveFormatError("archive-bad-shape", "lone surrogate in bundle data");
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= str.length || str.charCodeAt(i + 1) < 0xdc00 || str.charCodeAt(i + 1) > 0xdfff) throw bad();
      i++; // skip the low surrogate of a valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) throw bad();
  }
}

/** KV keys that are EPHEMERAL coordination state — meaningless off-profile.
 * "cap:importBackup" is the import-recovery journal (chrome-agent-platform-
 * ch8x): it holds PRE-sanitization colliding values while an import runs, so
 * it must never ride an export into another bundle. */
const EPHEMERAL_KV_KEYS = new Set([
  "cap:webmcpBridgeNonces",
  "cap:webmcpSnapshotGate",
  "cap:importBackup",
]);

/** Keys that must NEVER leave the profile (secret material). The bundle
 * carries a shape-only summary instead (configuredProviders/mcpServers). */
const SECRET_KV_KEYS = new Set([
  "providerConfig", // provider API keys live here
]);

/** Rebuildable caches: excluded from the bundle (they refill on demand). */
const EXCLUDED_OPFS_PREFIXES = ["cache/"];

export const EXCLUSION_POLICY = Object.freeze([
  "provider API keys (the bundle records which providers were configured, never their secrets)",
  "MCP server auth headers (the bundle records which servers had them)",
  "session state (chrome.storage.session and in-memory coordination keys)",
  "rebuilt-on-demand caches (model catalogs and other cache trees)",
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
    clear: async (name) => {
      await chrome.alarms.clear(name);
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
    if (EXCLUDED_OPFS_PREFIXES.some((p) => path.startsWith(p))) continue;
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

/** Parse + validate a bundle. Any foreign/corrupt input is a typed refusal.
 * Deep validation happens HERE — entry data is fully decoded (base64 checked,
 * utf8 surrogate-checked), every path classified, alarm shapes and duplicate
 * names checked, and the manifest cross-checked against the contents — so a
 * damaged bundle is refused BEFORE an import can touch the profile. Decoded
 * bytes ride along as entry._bytes so the apply phase never re-decodes. */
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
  if (hasOwn(parsed.kv, IMPORT_SIDECAR_KEY)) {
    throw new ArchiveFormatError("archive-bad-shape", "reserved recovery key in bundle kv");
  }
  const seenPaths = new Set();
  for (const entry of parsed.opfs) {
    validateOpfsPath(entry?.path);
    if ((entry.encoding !== "utf8" && entry.encoding !== "base64") || typeof entry.data !== "string") {
      throw new ArchiveFormatError("archive-bad-shape", "bad bundle entry encoding or data");
    }
    if (entry.encoding === "utf8") {
      assertNoLoneSurrogates(entry.data);
      entry._bytes = ENCODER.encode(entry.data);
    } else {
      entry._bytes = b64Decode(entry.data);
    }
    if (seenPaths.has(entry.path)) {
      throw new ArchiveFormatError("archive-bad-shape", "duplicate paths in bundle");
    }
    seenPaths.add(entry.path);
  }
  if (!Array.isArray(parsed.alarms)) parsed.alarms = [];
  const seenAlarms = new Set();
  for (const alarm of parsed.alarms) {
    if (
      !alarm || typeof alarm !== "object" || Array.isArray(alarm) || typeof alarm.name !== "string" ||
      (alarm.scheduledTime != null && typeof alarm.scheduledTime !== "number") ||
      (alarm.periodInMinutes != null && typeof alarm.periodInMinutes !== "number")
    ) {
      throw new ArchiveFormatError("archive-bad-shape", "malformed alarm record in bundle");
    }
    if (seenAlarms.has(alarm.name)) {
      throw new ArchiveFormatError("archive-bad-shape", "duplicate alarm names in bundle");
    }
    seenAlarms.add(alarm.name);
  }
  if (!Array.isArray(parsed.configuredProviders)) parsed.configuredProviders = [];
  if (!Array.isArray(parsed.mcpServers)) parsed.mcpServers = [];
  if (!parsed.policy || !Array.isArray(parsed.policy.excluded)) parsed.policy = { excluded: [...EXCLUSION_POLICY] };
  // Manifest integrity: REQUIRED and internally consistent. A mismatch means
  // the bundle is truncated or tampered — refuse before any mutation.
  const m = parsed.manifest;
  if (!m || typeof m !== "object" || Array.isArray(m) || ["kvKeys", "opfsFiles", "alarms", "totalBytes"].some((f) => !Number.isInteger(m[f]))) {
    throw new ArchiveFormatError("archive-bad-manifest", "bundle carries no valid manifest");
  }
  const actualTotalBytes =
    parsed.opfs.reduce((n, e) => n + e._bytes.length, 0) + ENCODER.encode(JSON.stringify(parsed.kv)).length;
  if (
    m.kvKeys !== Object.keys(parsed.kv).length ||
    m.opfsFiles !== parsed.opfs.length ||
    m.alarms !== parsed.alarms.length ||
    m.totalBytes !== actualTotalBytes
  ) {
    throw new ArchiveFormatError(
      "archive-manifest-mismatch",
      `manifest mismatch: declared ${m.totalBytes} bytes, actual ${actualTotalBytes}`,
    );
  }
  return parsed;
}

/**
 * Recover a crashed import from its durable sidecar journal. The journal
 * ("cap:importBackup", written by importArchive before any mutation) records
 * what the import would create and byte-backups of everything it would
 * overwrite; this restores the original profile exactly, then deletes the
 * journal. No-op (returns false) when no journal is present. Runs at every
 * import entry AND on every worker boot, so even an MV3 worker death
 * mid-apply cannot expose a mixed profile beyond the next restart/import.
 */
export async function recoverPendingImport({ kvGet, kvSet, kvRemove, opfs, alarms } = {}) {
  // The injected kvGet mirrors chrome.storage.local.get: a single-key read
  // returns the {key: value} ENVELOPE (lib/kv.js), while test fakes may
  // return the bare value — normalize both.
  const raw = await kvGet(IMPORT_SIDECAR_KEY);
  const journal = raw && typeof raw === "object" && hasOwn(raw, IMPORT_SIDECAR_KEY) ? raw[IMPORT_SIDECAR_KEY] : raw;
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return false;
  const kvOld = journal.kvOld || {};
  const filesOld = journal.filesOld || {};
  // Undo in the inverse order of the apply phase.
  for (const name of journal.alarmsNew || []) await alarms.clear(name);
  for (const rec of journal.alarmsOld || []) {
    const { name, ...info } = rec; // journal records carry the chrome.alarms.create shape
    await alarms.create(name, info);
  }
  for (const path of journal.filesNew || []) {
    if (hasOwn(filesOld, path)) continue; // restored below from its backup
    try {
      await opfs.removeFile(path);
    } catch {
      /* the crash happened before this file was written — nothing to undo */
    }
  }
  for (const [path, b64] of Object.entries(filesOld)) {
    await opfs.writeFile(path, b64Decode(b64));
  }
  for (const key of journal.kvNew || []) await kvRemove(key);
  const kvOldEntries = Object.entries(kvOld);
  if (kvOldEntries.length) await kvSet(Object.fromEntries(kvOldEntries));
  await kvRemove(IMPORT_SIDECAR_KEY);
  return true;
}

/**
 * Import a bundle into a target profile — verified write-before-wipe with a
 * durable rollback journal. Phase 1 validates the whole bundle (deeply, at
 * parse) and the target state (a non-empty target refuses without
 * `overwrite: true` and is left untouched). Phase 2 stages the bundle's
 * content on the target and byte-verifies it BEFORE any pre-existing state is
 * destroyed; a journal written first makes every pre-publication failure —
 * including an MV3 worker death — recoverable to a byte-identical original.
 * Only after full verification does the commit prune delete pre-existing
 * state the bundle does not carry.
 */
export async function importArchive(bundleText, { kvGet, kvSet, kvRemove, opfs, alarms, overwrite = false } = {}) {
  const parsed = parseArchive(bundleText);

  // Self-heal FIRST: a previous import that died mid-apply left a recovery
  // journal — restore the original profile before anything else reads it.
  const backends = { kvGet, kvSet, kvRemove, opfs, alarms };
  await recoverPendingImport(backends);

  // Phase 1 — target state check BEFORE any mutation.
  const existingKv = (await kvGet(null)) || {};
  const existingKeys = Object.keys(existingKv);
  const existingFiles = await opfs.listFiles();
  const existingAlarms = (await alarms.getAll()) || [];
  if (!overwrite && (existingKeys.length || existingFiles.length || existingAlarms.length)) {
    throw new Error(
      `import refused: the target profile is not empty (${existingKeys.length} settings keys, ${existingFiles.length} stored files, ${existingAlarms.length} alarms) — nothing was touched without the explicit overwrite choice`,
    );
  }

  const kvEntries = Object.entries(parsed.kv);
  const bundlePathList = parsed.opfs.map((e) => e.path);
  const bundlePaths = new Set(bundlePathList);
  const bundleAlarmNames = new Set(parsed.alarms.map((a) => a.name));

  // The sidecar journal: what the bundle will create (kvNew/filesNew/
  // alarmsNew) and backups of everything it OVERWRITES (kvOld/filesOld/
  // alarmsOld — file bytes as base64 so chrome.storage persists it verbatim).
  // Staged in BOTH modes — a clean target can also die mid-apply and leave
  // orphan partials. Pre-existing state the bundle does NOT carry is never
  // touched before the commit prune, so it needs no backup. A failure here
  // refuses before ANY mutation. (Quota-ceiling ponytail note: the journal
  // duplicates only the overwritten subset in memory/KV; streaming is 11rm's.)
  const cleanAlarms = existingAlarms.filter((a) => a && typeof a.name === "string");
  const kvOld = {};
  for (const key of existingKeys) {
    if (hasOwn(parsed.kv, key)) kvOld[key] = structuredClone(existingKv[key]);
  }
  const filesOld = {};
  for (const path of existingFiles) {
    if (bundlePaths.has(path)) filesOld[path] = b64Encode(await opfs.readFile(path));
  }
  const journal = {
    kvNew: kvEntries.map(([k]) => k),
    kvOld,
    filesNew: bundlePathList,
    filesOld,
    alarmsNew: parsed.alarms.map((a) => a.name),
    alarmsOld: cleanAlarms.map((a) => ({ name: a.name, ...alarmRecInfo(a) })),
  };
  try {
    await kvSet({ [IMPORT_SIDECAR_KEY]: journal });
  } catch (err) {
    throw new ArchiveFormatError("import-sidecar-failed", `recovery journal write failed (${err?.message || err}); nothing was modified`);
  }

  try {
    if (kvEntries.length) await kvSet(Object.fromEntries(kvEntries.map(([k, v]) => [k, structuredClone(v)])));
    for (const entry of parsed.opfs) await opfs.writeFile(entry.path, entry._bytes);

    // Verify EVERY restored byte by re-reading it — BEFORE the destructive
    // prune, so a mismatch can never cost pre-existing data.
    for (const entry of parsed.opfs) {
      const back = await opfs.readFile(entry.path);
      if (back.length !== entry._bytes.length || back.some((b, i) => b !== entry._bytes[i])) {
        throw new ArchiveFormatError("import-verify-failed", `restored file failed verification: ${entry.path}`);
      }
    }
    const kvBack = (await kvGet(null)) || {};
    for (const [key, value] of kvEntries) {
      if (JSON.stringify(kvBack[key]) !== JSON.stringify(value)) {
        throw new ArchiveFormatError("import-verify-failed", `restored setting failed verification: ${key}`);
      }
    }

    for (const alarm of parsed.alarms) await alarms.create(alarm.name, alarmRecInfo(alarm));
  } catch (err) {
    // Pre-publication failure — restore the original profile byte-for-byte.
    let restored = false;
    try {
      restored = await recoverPendingImport(backends);
    } catch {
      restored = false;
    }
    if (!restored) {
      throw new ArchiveFormatError(
        "import-rollback-failed",
        `import failed (${err?.message || err}) and recovery failed; import again or restart to recover`,
      );
    }
    throw new ArchiveFormatError("import-rollback", `import failed pre-commit; original profile restored (${err?.message || err})`);
  }

  // COMMIT — every bundle byte is verified on the target. Destructive from
  // here on: prune pre-existing state the bundle does not carry, then delete
  // the journal (the commit point). A failure or worker death inside THIS
  // phase leaves the full verified bundle plus possibly stale extras —
  // loss-free, and the next import (which self-heals, then re-applies) cleans
  // it up. A restored alarm whose `when` already passed may fire once after
  // recovery — cosmetic.
  for (const a of cleanAlarms) {
    if (!bundleAlarmNames.has(a.name)) await alarms.clear(a.name);
  }
  for (const path of existingFiles) {
    if (!bundlePaths.has(path)) await opfs.removeFile(path);
  }
  for (const key of existingKeys) {
    if (!hasOwn(parsed.kv, key)) await kvRemove(key);
  }
  await kvRemove(IMPORT_SIDECAR_KEY);

  return Object.freeze({
    ok: true,
    restored: Object.freeze({
      kvKeys: kvEntries.length,
      opfsFiles: parsed.opfs.length,
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
