// Read-only owner diagnostic, NOT an authority reader, cutover switch or repair.
// A diagnostic error is never permission to use stale journal.json. Product
// readers continue to use the strict WAL projection and fail closed.
import {
  readMasterJournalArchiveChain,
  readMasterJournalHead,
  readMasterJournalProjection,
} from "./master-journal-wal.js";

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
