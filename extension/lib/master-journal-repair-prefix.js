// Read-only, bounded owner diagnostic. A historical head can be checked in
// isolation without becoming authority. Product readers MUST still use the
// strict combined-head projection; this module offers no repair publisher.
import { snapshotMasterJournalRepairEvidence } from "./master-journal-owner-inspection.js";
import {
  readMasterJournalArchiveChain,
  readMasterJournalProjection,
  unsealMasterJournalRecord,
} from "./master-journal-wal.js";

const HEADS = ["head-a.json", "head-b.json"];
const INTENT = /^repair-intent-([1-9]\d*)\.json$/;

function absent(name) {
  return new DOMException(`master journal diagnostic ${name} is absent`, "NotFoundError");
}

/** Caller holds the master Web Lock for a stable evidence snapshot. No bytes,
 * actionable quarantine list or authority selection leave this diagnostic.
 * At most 256 WAL leaves / 16 MiB total are inspected by the evidence gate. */
export async function inspectIntactMasterJournalPrefixesForOwner(master) {
  const evidence = await snapshotMasterJournalRepairEvidence(master);
  const base = { actionable: false, authoritySelected: false, candidates: [], heads: [] };
  if (evidence.state === "inspection_refused") {
    return { ...base, state: "inspection_refused", reason: evidence.refusals[0] };
  }
  let directory;
  try { directory = await master.getDirectoryHandle("journal-wal"); }
  catch (error) {
    if (error?.name === "NotFoundError") return { ...base, state: "wal_absent" };
    return { ...base, state: "inspection_refused", reason: String(error?.message ?? error) };
  }
  const heads = [];
  for (const slot of HEADS) {
    let handle;
    try { handle = await directory.getFileHandle(slot); }
    catch (error) {
      heads.push({ slot, checked: false, reason: error?.name === "NotFoundError" ? "absent" : "unreadable" });
      continue;
    }
    try {
      const file = await handle.getFile();
      if (file.size > 65536) throw new Error("head exceeds owner diagnostic byte bound");
      const bytes = await file.arrayBuffer();
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((value) => value.toString(16).padStart(2, "0")).join("");
      if (sha256 !== evidence.records.find((record) => record.name === slot)?.sha256) {
        throw new Error("head changed after bounded owner evidence snapshot");
      }
      const selected = await unsealMasterJournalRecord(bytes, "head");
      const repairThrough = selected.repairIntentSequence ?? 0;
      const historicalDirectory = {
        async getFileHandle(name) {
          if (name === HEADS[0]) return handle;
          if (name === HEADS[1]) throw absent(name);
          const intent = INTENT.exec(name);
          if (intent && Number(intent[1]) > repairThrough) throw absent(name);
          return directory.getFileHandle(name);
        },
      };
      const historicalMaster = {
        async getDirectoryHandle(name) {
          if (name !== "journal-wal") throw absent(name);
          return historicalDirectory;
        },
      };
      const projection = await readMasterJournalProjection(historicalMaster);
      if (!projection) throw new Error("diagnostic head is absent");
      const archive = await readMasterJournalArchiveChain(historicalMaster, projection.head,
        { includeRows: false });
      heads.push({ slot, checked: true, sha256, epoch: projection.head.epoch,
        sequence: projection.head.sequence, version: projection.head.version,
        checkpointSequence: projection.head.checkpointSequence,
        archiveSegments: archive.names.length });
    } catch (error) {
      heads.push({ slot, checked: false, reason: String(error?.message ?? error) });
    }
  }
  return { ...base, state: "historical_prefix_diagnostic", heads };
}
