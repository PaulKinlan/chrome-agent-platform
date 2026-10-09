// Persist a checkpoint+source-specific issuance claim before pure derived
// compaction records are written. The caller holds the master Web Lock for the
// entire transaction. Product WAL writes remain OFF until all routes are wired.
import { capLog } from "./cap-log.js";
import { sealMasterJournalRecord, unsealMasterJournalRecord } from "./master-journal-wal.js";

const DECODER = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();
const LOG = capLog("master-journal-wal");
const CLAIM_DIRECTORY = "journal-wal";

function isMissing(error) { return error?.name === "NotFoundError"; }

async function optionalFile(directory, name) {
  try { return await directory.getFileHandle(name); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

function checkedName({ checkpoint, source }) {
  const matched = /^checkpoint-([1-9]\d*)-([1-9]\d*)\.json$/u.exec(checkpoint ?? "");
  if (!matched || !source || typeof source !== "object" ||
      Number(matched[1]) !== source.epoch ||
      Number(matched[2]) !== source.throughFrame + 1) {
    throw new Error("invalid master journal compaction issuance claim");
  }
  return `claim-${matched[1]}-${matched[2]}.json`;
}

/** The exact record is NOT a journal projection dependency. A raw backup omits
 * these unreferenced retry witnesses; a restored published head never needs
 * its old claim. A surviving orphan checkpoint DOES require its matching
 * complete claim to be adopted after a crash. */
export function createMasterJournalIssuer(master, { issueVersion, readGeneration } = {}) {
  if (typeof issueVersion !== "function" || typeof readGeneration !== "function") {
    throw new Error("master journal issuer requires a durable version authority");
  }
  async function readClaim(claim) {
    const name = checkedName(claim);
    let directory;
    try { directory = await master.getDirectoryHandle(CLAIM_DIRECTORY); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    const file = await optionalFile(directory, name);
    if (!file) return null;
    let payload;
    let serialized;
    try {
      serialized = DECODER.decode(await (await file.getFile()).arrayBuffer());
      payload = await unsealMasterJournalRecord(serialized, "claim");
    } catch (error) {
      throw new Error(`master journal unpublished claim ${name} requires explicit owner repair`, { cause: error });
    }
    if (payload.checkpoint !== claim.checkpoint ||
        JSON.stringify(payload.source) !== JSON.stringify(claim.source) ||
        !Number.isSafeInteger(payload.version) || payload.version < claim.source.version + 1 ||
        serialized !== await sealMasterJournalRecord("claim", payload)) {
      throw new Error(`master journal unpublished claim ${name} source or payload mismatch requires explicit owner repair`);
    }
    let floor;
    try { floor = await readGeneration(); }
    catch (error) {
      throw new Error("master journal durable generation witness is corrupt", { cause: error });
    }
    if (!Number.isSafeInteger(floor) || floor < payload.version) {
      throw new Error(`master journal unpublished claim ${name} has no durable generation witness`);
    }
    return payload.version;
  }

  return Object.freeze({
    async allocateVersion(claim = null) {
      if (!claim) return await issueVersion(); // ordinary frame / cutover
      const name = checkedName(claim);
      const previous = await readClaim(claim);
      if (previous !== null) {
        LOG.info("verified compaction issuance reuse", { name, epoch: claim.source.epoch,
          throughFrame: claim.source.throughFrame });
        return previous;
      }
      const version = await issueVersion(); // globally persisted BEFORE staging the claim
      if (!Number.isSafeInteger(version) || version <= claim.source.version) {
        throw new Error("master journal compaction version must increase");
      }
      const directory = await master.getDirectoryHandle(CLAIM_DIRECTORY, { create: true });
      if (await optionalFile(directory, name)) {
        throw new Error(`master journal unpublished claim ${name} requires explicit owner repair`);
      }
      const payload = { checkpoint: claim.checkpoint, source: claim.source, version };
      const serialized = await sealMasterJournalRecord("claim", payload);
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try { await writable.write(ENCODER.encode(serialized)); await writable.close(); }
      catch (error) { try { await writable.abort?.(); } catch { /* retain evidence */ } throw error; }
      if (await readClaim(claim) !== version) {
        throw new Error(`master journal unpublished claim ${name} readback mismatched`);
      }
      return version;
    },
    async readIssuedVersion(claim) { return await readClaim(claim); },
  });
}
