// Read-only owner diagnostic, NOT an authority reader, cutover switch or repair.
// A diagnostic error is never permission to use stale journal.json. Product
// readers continue to use the strict WAL projection and fail closed.
import {
  readMasterJournalArchiveChain,
  readMasterJournalHead,
  readMasterJournalProjection,
} from "./master-journal-wal.js";
import {
  collectMasterJournalRepairEvidenceInventory,
  hashMasterJournalRepairEvidenceInventory,
} from "./master-journal-repair-evidence.js";
export { fingerprintRequestedMasterJournalRepairLeaves } from "./master-journal-repair-evidence.js";

// The raw bounded inventory cannot decide authority. This owner-facing view
// adds the strict WAL inspection after collecting fingerprints. The WAL issuer
// imports only the independent inventory module, so there is no ESM cycle.
export async function snapshotMasterJournalRepairEvidence(master, limits = {}) {
  const evidence = await collectMasterJournalRepairEvidenceInventory(master, limits);
  if (evidence.state === "inspection_refused") return evidence;
  const inspection = await inspectMasterJournalForOwner(master);
  return { ...inspection, ...evidence,
    authorityOutcomeRequired: inspection.state === "requires_explicit_owner_repair",
    refusals: inspection.state === "requires_explicit_owner_repair" ? [inspection.reason] :
      inspection.state === "current_head_checked" ? ["older-head reachability not verified for repair"] : [],
  };
}

/** Exact bounded evidence identity for a later explicit owner repair request.
 * This is NOT an approval token, lock, write permit, quarantine candidate or
 * substitute for repeating the snapshot under the master authority lock. */
export async function fingerprintMasterJournalRepairEvidence(master) {
  const evidence = await snapshotMasterJournalRepairEvidence(master);
  if (evidence.state === "inspection_refused") {
    throw new Error(`master journal repair evidence fingerprint refused: ${evidence.refusals[0]}`);
  }
  return { schemaVersion: 1, walPresent: evidence.walPresent,
    sha256: await hashMasterJournalRepairEvidenceInventory(evidence),
    recordCount: evidence.records.length, actionable: false,
    authorityOutcomeRequired: evidence.authorityOutcomeRequired, candidates: [] };
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
