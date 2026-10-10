// Bounded, read-only repair evidence inventory. This low-level module must NOT
// import the WAL reader: the WAL issuer rechecks these bytes under its caller's
// master Web Lock, while owner-inspection adds a separate strict authority view.
export async function collectMasterJournalRepairEvidenceInventory(master, {
  maxRecords = 1024, maxRecordBytes = 8 * 1024 * 1024,
  maxTotalBytes = 16 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0 || maxRecords > 4096 ||
      !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 0 || maxRecordBytes > 32 * 1024 * 1024 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0 || maxTotalBytes > 64 * 1024 * 1024) {
    throw new Error("master journal repair evidence limits are invalid");
  }
  const refuse = (reason) => ({ state: "inspection_refused", actionable: false,
    authorityOutcomeRequired: true, candidates: [], records: [], refusals: [reason] });
  let directory;
  try { directory = await master.getDirectoryHandle("journal-wal"); }
  catch (error) {
    if (error?.name !== "NotFoundError") return refuse(`master journal repair evidence unreadable: ${error?.message ?? error}`);
    directory = null;
  }
  const records = [];
  let totalBytes = 0;
  try {
    for await (const [name, handle] of directory?.entries() ?? []) {
      if (records.length >= maxRecords) return refuse("master journal repair evidence record count exceeds limit");
      if (typeof name !== "string" || !name || typeof handle?.getFile !== "function") {
        return refuse("master journal repair evidence has an unclassified directory or leaf");
      }
      const file = await handle.getFile();
      if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > maxRecordBytes) {
        return refuse("master journal repair evidence record exceeds byte limit");
      }
      if (totalBytes + file.size > maxTotalBytes) {
        return refuse("master journal repair evidence total bytes exceed limit");
      }
      totalBytes += file.size;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== file.size) return refuse("master journal repair evidence record changed during read");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      records.push({ name, bytes: file.size,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") });
    }
  } catch (error) { return refuse(`master journal repair evidence unreadable: ${error?.message ?? error}`); }
  const legacy = {};
  try {
    for (const [key, filename] of [["journal", "journal.json"], ["archive", "journal-archive.json"]]) {
      let handle;
      try { handle = await master.getFileHandle(filename); }
      catch (error) {
        if (error?.name !== "NotFoundError") throw error;
        legacy[key] = { present: false };
        continue;
      }
      const file = await handle.getFile();
      if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > maxRecordBytes) {
        return refuse("master journal repair evidence record exceeds byte limit");
      }
      if (totalBytes + file.size > maxTotalBytes) {
        return refuse("master journal repair evidence total bytes exceed limit");
      }
      totalBytes += file.size;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== file.size) return refuse("master journal repair evidence record changed during read");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      legacy[key] = { present: true, bytes: file.size,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
    }
  } catch (error) { return refuse(`master journal repair evidence unreadable: ${error?.message ?? error}`); }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return { walPresent: directory !== null, records, legacy, actionable: false, candidates: [] };
}

export async function hashMasterJournalRepairEvidenceInventory(evidence) {
  const body = JSON.stringify({ schemaVersion: 1, walPresent: evidence.walPresent,
    records: evidence.records, legacy: evidence.legacy });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Requested names are forensics, never approval or quarantine candidates. */
export async function fingerprintRequestedMasterJournalRepairLeaves(master, names) {
  if (!Array.isArray(names) || names.length > 32 ||
      names.some((name) => typeof name !== "string" || !name || name.length > 128 ||
        name.includes("/") || name.startsWith("repair-intent-") || name.startsWith("quarantine-")) ||
      new Set(names).size !== names.length) {
    throw new Error("master journal requested repair leaves are invalid or repeated");
  }
  const evidence = await collectMasterJournalRepairEvidenceInventory(master);
  if (evidence.state === "inspection_refused") {
    throw new Error(`master journal requested repair evidence refused: ${evidence.refusals[0]}`);
  }
  const requestedRecords = names.map((name) => {
    const record = evidence.records.find((row) => row.name === name);
    if (!record) throw new Error(`master journal requested repair leaf ${name} is missing`);
    return record;
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 1,
    evidenceSha256: await hashMasterJournalRepairEvidenceInventory(evidence),
    actionable: false, authorityOutcomeRequired: true, candidates: [], requestedRecords };
}
