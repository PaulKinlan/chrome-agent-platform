// Read-only owner diagnostic, NOT an authority reader, cutover switch or repair.
// A diagnostic error is never permission to use stale journal.json. Product
// readers continue to use the strict WAL projection and fail closed.
import {
  readMasterJournalArchiveChain,
  readMasterJournalHead,
  readMasterJournalProjection,
} from "./master-journal-wal.js";

// Evidence inventory only: never a quarantine instruction. The hard limits
// cap a single explicit owner inspection, not the size of legitimate history.
// Oversized/unknown records refuse rather than being silently omitted.
export async function snapshotMasterJournalRepairEvidence(master, {
  maxRecords = 256, maxRecordBytes = 8 * 1024 * 1024,
  maxTotalBytes = 16 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0 || maxRecords > 256 ||
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
  // These are only fingerprints, never a second source of authority. A
  // pre-head directory must keep refusing even when legacy bytes look valid.
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
  const inspection = await inspectMasterJournalForOwner(master);
  return { ...inspection, actionable: false,
    authorityOutcomeRequired: inspection.state === "requires_explicit_owner_repair",
    candidates: [], records, legacy,
    refusals: inspection.state === "requires_explicit_owner_repair" ? [inspection.reason] :
      inspection.state === "current_head_checked" ? ["older-head reachability not verified for repair"] : [],
  };
}

export async function inspectMasterJournalForOwner(master) {
  try {
    const head = await readMasterJournalHead(master);
    // Only a WAL directory that is absent or actually empty reaches this
    // branch. Pre-head residue (even a single torn file) throws above.
    if (!head) return { state: "legacy_empty_or_absent_wal" };
    const current = await readMasterJournalProjection(master);
    const archive = await readMasterJournalArchiveChain(master, head, { includeRows: false });
    return {
      state: "current_head_checked",
      head: { epoch: head.epoch, sequence: head.sequence, version: head.version,
        checkpointSequence: head.checkpointSequence },
      liveRows: current.live.length,
      archiveSegments: archive.names.length,
      // This inspection checks both head-slot shapes and the selected head's
      // projection/archive chain. It does NOT attest every older-head frame;
      // the export/restore validator remains the full two-head gate.
      olderHeadReplayVerified: false,
    };
  } catch (error) {
    return {
      state: "requires_explicit_owner_repair",
      reason: String(error?.message ?? error),
    };
  }
}
