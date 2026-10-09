// Master-only journal authority. A legacy journal remains authoritative until
// the first checked head is published; staged files are never treated as rows.
// The writer is deliberately NOT enabled by this module: all master mutation,
// CAS, archive and export paths must share this authority before cutover can be
// called from production. Agent/site journals continue using their old store.
const DIRECTORY = "journal-wal";
const HEADS = ["head-a.json", "head-b.json"];
const MAGIC = "cap-master-journal-wal-v1";
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

async function hash(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODER.encode(text)));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** The hash covers the *canonical JSON body*, not the outer envelope. */
export async function sealMasterJournalRecord(kind, payload) {
  if (!["head", "checkpoint", "archive", "frame"].includes(kind)) throw new Error("unknown journal record kind");
  const body = JSON.stringify({ magic: MAGIC, kind, payload });
  if (typeof body !== "string") throw new Error("journal record cannot be serialized");
  return JSON.stringify({ body, sha256: await hash(body) });
}

export async function unsealMasterJournalRecord(serialized, kind) {
  let outer;
  try { outer = JSON.parse(typeof serialized === "string" ? serialized : DECODER.decode(serialized)); }
  catch { throw new Error("master journal record is incomplete or corrupt"); }
  if (!outer || typeof outer.body !== "string" || !/^[0-9a-f]{64}$/.test(outer.sha256)) {
    throw new Error("master journal record checksum envelope is corrupt");
  }
  if (await hash(outer.body) !== outer.sha256) throw new Error("master journal record checksum mismatch");
  let record;
  try { record = JSON.parse(outer.body); } catch { throw new Error("master journal record body is corrupt"); }
  if (record?.magic !== MAGIC || record.kind !== kind || !record.payload || typeof record.payload !== "object") {
    throw new Error("master journal record kind or schema mismatch");
  }
  return record.payload;
}

async function optionalDirectory(master) {
  try { return await master.getDirectoryHandle(DIRECTORY); }
  catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

async function optionalFile(directory, name) {
  try { return await directory.getFileHandle(name); }
  catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

async function readRecord(directory, name, kind) {
  const handle = await optionalFile(directory, name);
  if (!handle) return null;
  const file = await handle.getFile();
  return await unsealMasterJournalRecord(await file.arrayBuffer(), kind);
}

async function writeCheckedRecord(directory, name, kind, payload) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(await sealMasterJournalRecord(kind, payload));
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* the read below must fail closed */ }
    throw error;
  }
  const actual = await readRecord(directory, name, kind);
  if (JSON.stringify(actual) !== JSON.stringify(payload)) throw new Error("master journal record readback mismatch");
  return actual;
}

function validateHead(head) {
  if (!safeInteger(head.epoch, 1) || !safeInteger(head.sequence) ||
      !safeInteger(head.version, 1) || !safeInteger(head.checkpointSequence) ||
      head.checkpointSequence > head.sequence ||
      typeof head.checkpoint !== "string" || !/^checkpoint-[1-9]\d*-[0-9]+\.json$/.test(head.checkpoint) ||
      typeof head.archive !== "string" || !/^archive-[1-9]\d*-[0-9]+\.json$/.test(head.archive) ||
      typeof head.lastHash !== "string" || !/^[0-9a-f]{64}$/.test(head.lastHash)) {
    throw new Error("master journal head is corrupt");
  }
  return head;
}

/** A corrupt present head is never silently ignored in favor of an older one.
 * Even a lone torn head-a with head-b absent may have been valid and
 * acknowledged BEFORE later corruption: without an independent cutover
 * witness, its shape cannot prove it was merely a failed first publication. */
export async function readMasterJournalHead(master) {
  const directory = await optionalDirectory(master);
  if (!directory) return null;
  const heads = [];
  for (const slot of HEADS) {
    const head = await readRecord(directory, slot, "head");
    if (head) heads.push(validateHead(head));
  }
  if (heads.length === 0) return null;
  if (heads.length === 1 && !(await optionalFile(directory, HEADS[0]))) {
    throw new Error("master journal cutover head is missing");
  }
  if (heads.length === 2 && heads[0].epoch !== heads[1].epoch) throw new Error("master journal head epochs disagree");
  if (heads.length === 2 && heads[0].sequence === heads[1].sequence && JSON.stringify(heads[0]) !== JSON.stringify(heads[1])) {
    throw new Error("master journal heads fork at the same sequence");
  }
  return heads.sort((a, b) => b.sequence - a.sequence)[0];
}

/** Reads only a fully published, checked checkpoint; no staged file is authority. */
export async function readMasterJournalProjection(master, { includeArchive = false } = {}) {
  const head = await readMasterJournalHead(master);
  if (!head) return null; // old profile: ordinary journal.json remains authoritative
  const directory = await optionalDirectory(master);
  const expectedHeadHash = await hash(JSON.stringify({
    epoch: head.epoch, sequence: head.checkpointSequence,
    checkpoint: head.checkpoint, archive: head.archive,
  }));
  if (head.sequence === head.checkpointSequence && head.lastHash !== expectedHeadHash) {
    throw new Error("master journal head/checkpoint binding is corrupt");
  }
  const checkpoint = await readRecord(directory, head.checkpoint, "checkpoint");
  if (!checkpoint || checkpoint.epoch !== head.epoch || checkpoint.sequence !== head.checkpointSequence ||
      typeof checkpoint.exists !== "boolean" || !Array.isArray(checkpoint.live)) {
    throw new Error("master journal checkpoint is missing or corrupt");
  }
  // A checkpoint can contain up to 500 WHOLE rows. A different limit here
  // would let a malformed export bypass the bounded live view.
  if (checkpoint.live.length > 500) throw new Error("master journal checkpoint is unbounded");
  const result = { exists: checkpoint.exists, live: structuredClone(checkpoint.live), version: head.version, head };
  let previousHash = expectedHeadHash;
  let previousVersion = head.epoch;
  const overflow = [];
  let archiveCleared = false;
  for (let sequence = head.checkpointSequence + 1; sequence <= head.sequence; sequence++) {
    if (sequence - head.checkpointSequence > 128) throw new Error("master journal replay exceeds the checkpoint bound");
    const file = await optionalFile(directory, `frame-${head.epoch}-${sequence}.json`);
    if (!file) throw new Error(`master journal frame ${sequence} is missing`);
    const serialized = DECODER.decode(await (await file.getFile()).arrayBuffer());
    const frame = await unsealMasterJournalRecord(serialized, "frame");
    if (frame.epoch !== head.epoch || frame.sequence !== sequence || frame.previousHash !== previousHash ||
        !safeInteger(frame.version, previousVersion + 1)) {
      throw new Error("master journal frame chain or version is corrupt");
    }
    if (frame.operation === "append" && frame.row && typeof frame.row === "object" && !Array.isArray(frame.row)) {
      result.live.push(structuredClone(frame.row));
      if (result.live.length > 500) overflow.push(...result.live.splice(0, result.live.length - 500));
      result.exists = true;
    } else if (frame.operation === "replace" && Array.isArray(frame.rows) && frame.rows.length <= 500) {
      result.live = structuredClone(frame.rows);
      result.exists = true;
    } else if (frame.operation === "delete") {
      result.live = [];
      result.exists = false;
    } else if (frame.operation === "clear") {
      result.live = [];
      result.exists = false;
      overflow.length = 0;
      archiveCleared = true;
    } else throw new Error("master journal frame operation is corrupt");
    previousVersion = frame.version;
    previousHash = await hash(serialized);
  }
  if (head.lastHash !== previousHash || (head.sequence > head.checkpointSequence && head.version !== previousVersion)) {
    throw new Error("master journal terminal head does not match its checked frame chain");
  }
  if (includeArchive) {
    const archive = await readRecord(directory, head.archive, "archive");
    if (!archive || archive.epoch !== head.epoch || !Array.isArray(archive.rows)) {
      throw new Error("master journal archive is missing or corrupt");
    }
    if ((archive.exists !== undefined && typeof archive.exists !== "boolean") ||
        (archive.exists === false && archive.rows.length > 0)) {
      throw new Error("master journal archive existence is corrupt");
    }
    result.archive = archiveCleared ? overflow : [...structuredClone(archive.rows), ...overflow];
    result.archiveExists = archiveCleared ? overflow.length > 0 : (archive.exists === true || result.archive.length > 0);
  }
  return result;
}

/** Writes a checked immutable operation frame then publishes one alternating
 * checked head slot. Test-only until the master store's *every* mutation and
 * export path use a single lock + projection. A failed head close is NOT an
 * acknowledgement; recovery fails closed on a corrupt present head. */
export async function stageMasterJournalFrame(master, operation, { allocateVersion } = {}) {
  if (typeof allocateVersion !== "function") throw new Error("master journal frame requires a durable version issuer");
  if (!operation || typeof operation !== "object" || Array.isArray(operation) ||
      !["append", "replace", "delete", "clear"].includes(operation.operation) ||
      (operation.operation === "append" && (!operation.row || typeof operation.row !== "object" || Array.isArray(operation.row))) ||
      (operation.operation === "replace" && (!Array.isArray(operation.rows) || operation.rows.length > 500)) ||
      Object.keys(operation).some((key) => !["operation", "row", "rows"].includes(key))) {
    throw new Error("invalid master journal frame operation");
  }
  const before = await readMasterJournalProjection(master);
  if (!before) throw new Error("master journal must be cut over before framing a write");
  const { head } = before;
  if (head.sequence - head.checkpointSequence >= 128) throw new Error("master journal needs verified compaction before another frame");
  const sequence = head.sequence + 1;
  const version = await allocateVersion();
  if (!safeInteger(version, head.version + 1)) throw new Error("master journal version must increase");
  const payload = { ...operation, epoch: head.epoch, sequence, previousHash: head.lastHash, version };
  const directory = await optionalDirectory(master);
  const frameName = `frame-${head.epoch}-${sequence}.json`;
  await writeCheckedRecord(directory, frameName, "frame", payload);
  // Bind the published head to the exact bytes read back, not a filename alone.
  const frame = await directory.getFileHandle(frameName);
  const serialized = DECODER.decode(await (await frame.getFile()).arrayBuffer());
  await unsealMasterJournalRecord(serialized, "frame");
  const next = validateHead({ ...head, sequence, version, lastHash: await hash(serialized) });
  await writeCheckedRecord(directory, HEADS[sequence % 2], "head", next);
  return next;
}

/** Testable crash-safe cutover primitive; NOT invoked by the product until all
 * mutation and raw-backup paths are WAL-aware. `allocateVersion` must persist a
 * never-reused master generation before returning. The caller holds the master
 * directory lock and must strict-read/validate both legacy values first. */
export async function stageMasterJournalCutover(master, {
  journalExists,
  journal,
  archive,
  archiveExists = archive?.length > 0,
  allocateVersion,
}) {
  if (typeof journalExists !== "boolean" || typeof archiveExists !== "boolean" ||
      !Array.isArray(journal) || !Array.isArray(archive) ||
      typeof allocateVersion !== "function") throw new Error("invalid legacy master journal cutover input");
  if (!archiveExists && archive.length > 0) throw new Error("master journal archive existence contradicts retained rows");
  if (await readMasterJournalHead(master)) throw new Error("master journal is already cut over");
  const epoch = await allocateVersion();
  if (!safeInteger(epoch, 1)) throw new Error("invalid master journal cutover generation");
  const directory = await master.getDirectoryHandle(DIRECTORY, { create: true });
  const overflow = journal.slice(0, Math.max(0, journal.length - 500));
  const live = journal.slice(-500);
  const checkpoint = `checkpoint-${epoch}-0.json`;
  const archiveFile = `archive-${epoch}-0.json`;
  await writeCheckedRecord(directory, checkpoint, "checkpoint", { epoch, sequence: 0, exists: journalExists, live });
  await writeCheckedRecord(directory, archiveFile, "archive", {
    epoch, exists: archiveExists || overflow.length > 0, rows: [...archive, ...overflow],
  });
  const lastHash = await hash(JSON.stringify({ epoch, sequence: 0, checkpoint, archive: archiveFile }));
  const head = validateHead({ epoch, sequence: 0, checkpointSequence: 0, checkpoint, archive: archiveFile, lastHash, version: epoch });
  // SINGLE PUBLICATION POINT: all earlier files were staged and read back;
  // legacy journal.json remains intact even if publication fails. A present
  // corrupt head fails closed; it is never silently treated as pre-cutover.
  await writeCheckedRecord(directory, HEADS[0], "head", head);
  return head;
}
