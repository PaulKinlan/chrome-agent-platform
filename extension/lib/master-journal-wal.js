import { capLog } from "./cap-log.js";
import { fingerprintMasterJournalRepairEvidence } from "./master-journal-owner-inspection.js";

// Master-only journal authority. A legacy journal remains authoritative until
// the first checked head is published; staged files are never treated as rows.
// The writer is deliberately NOT enabled by this module: all master mutation,
// CAS, archive and export paths must share this authority before cutover can be
// called from production. Agent/site journals continue using their old store.
const DIRECTORY = "journal-wal";
const HEADS = ["head-a.json", "head-b.json"];
const MAGIC = "cap-master-journal-wal-v1";
const MAX_ARCHIVE_SEGMENT_ROWS = 500;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const WAL_LOG = capLog("master-journal-wal");

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

async function hash(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODER.encode(text)));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** The hash covers the *canonical JSON body*, not the outer envelope. */
export async function sealMasterJournalRecord(kind, payload) {
  if (!["head", "checkpoint", "archive", "frame", "claim", "repair-intent"].includes(kind)) throw new Error("unknown journal record kind");
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
  // A failed immutable close can leave a torn unpublished file. Never reuse
  // its name and erase the evidence on retry: only an explicit, separately
  // verified repair may quarantine/remove such an orphan. Heads intentionally
  // alternate in fixed slots and are the sole mutable records.
  if (kind !== "head" && await optionalFile(directory, name)) {
    throw new Error(`master journal unpublished immutable record ${name} requires explicit repair`);
  }
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
      (head.checkpointHash !== undefined && !/^[0-9a-f]{64}$/.test(head.checkpointHash)) ||
      typeof head.archive !== "string" || !/^archive-[1-9]\d*-[0-9]+\.json$/.test(head.archive) ||
      (head.archiveHash !== undefined && !/^[0-9a-f]{64}$/.test(head.archiveHash)) ||
      ((head.repairIntentId !== undefined || head.repairIntentSequence !== undefined) &&
        (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(head.repairIntentId) ||
          !safeInteger(head.repairIntentSequence, 1) || head.repairIntentSequence > 32)) ||
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
  // An immutable owner repair intent is a fail-closed authority witness, not
  // a boot-recovered coordination key. Even when every head is absent, its
  // presence must NEVER make the old journal.json authoritative again.
  const firstIntent = await readRecord(directory, "repair-intent-1.json", "repair-intent");
  const validateIntent = (intent, sequence) => {
    if (!intent || intent.schemaVersion !== 1 || intent.sequence !== sequence ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(intent.id) ||
        !["pre-head-residue", "torn-head", "orphan-record", "owner-repair"].includes(intent.reason) ||
        (sequence > 1 && (!intent.previousHead ||
          !safeInteger(intent.previousHead.epoch, 1) ||
          !safeInteger(intent.previousHead.sequence) ||
          !safeInteger(intent.previousHead.version, 1) ||
          typeof intent.previousId !== "string"))) {
      throw new Error("master journal repair intent is corrupt");
    }
  };
  if (firstIntent) validateIntent(firstIntent, 1);
  const heads = [];
  for (const slot of HEADS) {
    const head = await readRecord(directory, slot, "head");
    if (head) heads.push(validateHead(head));
  }
  if (heads.length === 0) {
    if (firstIntent) throw new Error("master journal repair intent requires an owner-approved checked head");
    // A cutover may crash after staging its first immutable checkpoint or
    // archive but BEFORE publishing head-a. Without a separate durable
    // cutover witness, those bytes cannot prove a safe retry or that legacy
    // remains authoritative. Preserve them and require explicit owner repair;
    // never silently select the legacy journal or export it as pre-cutover.
    for await (const _ of directory.entries()) {
      throw new Error("master journal pre-head residue requires explicit owner repair");
    }
    return null; // An empty directory has no cutover evidence.
  }
  if (heads.length === 1 && !(await optionalFile(directory, HEADS[0]))) {
    throw new Error("master journal cutover head is missing");
  }
  if (heads.length === 2 && heads[0].epoch !== heads[1].epoch) throw new Error("master journal head epochs disagree");
  if (heads.length === 2 && heads[0].sequence === heads[1].sequence && JSON.stringify(heads[0]) !== JSON.stringify(heads[1])) {
    throw new Error("master journal heads fork at the same sequence");
  }
  if (heads.length === 2 && heads[0].sequence !== heads[1].sequence) {
    const [older, newer] = heads.sort((a, b) => a.sequence - b.sequence);
    if (newer.version <= older.version) throw new Error("master journal head version has regressed");
  }
  const selected = heads.sort((a, b) => b.sequence - a.sequence)[0];
  if (selected.repairIntentSequence !== undefined) {
    if (!firstIntent) throw new Error("master journal repair witness is missing");
    const ids = new Set();
    let previousId = null;
    for (let sequence = 1; sequence <= selected.repairIntentSequence; sequence++) {
      const intent = sequence === 1 ? firstIntent :
        await readRecord(directory, `repair-intent-${sequence}.json`, "repair-intent");
      if (!intent) throw new Error("master journal repair witness is missing");
      validateIntent(intent, sequence);
      if (ids.has(intent.id) || (sequence > 1 && intent.previousId !== previousId)) {
        throw new Error("master journal repair intent chain or ID is reused");
      }
      ids.add(intent.id);
      previousId = intent.id;
      if (sequence === selected.repairIntentSequence && sequence > 1 &&
          (selected.epoch !== intent.previousHead.epoch ||
            selected.sequence <= intent.previousHead.sequence ||
            selected.version <= intent.previousHead.version)) {
        throw new Error("master journal repair head did not advance beyond the prior checked head");
      }
      if (sequence === selected.repairIntentSequence && selected.repairIntentId !== intent.id) {
        throw new Error("master journal repair intent is not discharged by the selected checked head");
      }
    }
    if (await optionalFile(directory, `repair-intent-${selected.repairIntentSequence + 1}.json`)) {
      throw new Error("master journal newer repair intent pending");
    }
  } else if (firstIntent) {
    throw new Error("master journal repair intent is not discharged by the selected checked head");
  }
  return selected;
}

/** Staged, lock-scoped repair witness only. The owner route does not exist yet.
 * Publishing this immutable checked intent deliberately freezes journal reads
 * until a separately owner-approved head binds its exact identity. A failed
 * close leaves evidence; retry may NOT erase the same immutable name. */
export async function stageMasterJournalRepairIntent(master, { id, reason, expectedEvidenceSha256 } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
      !["pre-head-residue", "torn-head", "orphan-record", "owner-repair"].includes(reason) ||
      !/^[0-9a-f]{64}$/.test(expectedEvidenceSha256)) {
    throw new Error("master journal repair intent requires an exact ID, bounded reason and evidence fingerprint");
  }
  // The caller holds the master Web Lock. Re-read the owner's bounded WAL +
  // legacy fingerprints BEFORE creating even the first witness file; a stale
  // plan is not permission to change authority. This is still test-only and
  // does not grant owner approval or quarantine permission.
  const currentEvidence = await fingerprintMasterJournalRepairEvidence(master);
  if (currentEvidence.sha256 !== expectedEvidenceSha256) {
    throw new Error("master journal repair evidence changed before intent issuance");
  }
  const directory = await master.getDirectoryHandle(DIRECTORY, { create: true });
  let sequence = 1;
  let previousHead = null;
  let previousId = null;
  if (await optionalFile(directory, "repair-intent-1.json")) {
    // A newer witness may only follow an already checked, discharged one.
    // Never silently skip a torn/pending earlier intent or reuse its ID.
    const head = await readMasterJournalHead(master);
    if (!head?.repairIntentSequence || head.repairIntentId === id) {
      throw new Error("master journal re-repair requires a discharged older intent and new ID");
    }
    sequence = head.repairIntentSequence + 1;
    if (sequence > 32) throw new Error("master journal repair intent sequence is exhausted");
    previousHead = { epoch: head.epoch, sequence: head.sequence, version: head.version };
    previousId = head.repairIntentId;
  }
  return await writeCheckedRecord(directory, `repair-intent-${sequence}.json`, "repair-intent",
    { schemaVersion: 1, sequence, id, reason,
      ...(previousHead ? { previousHead, previousId } : {}) });
}

/** Follow immutable bounded archive records from a published terminal leaf.
 * The old single-record fixture is accepted as a root, but new cutovers
 * always bind the terminal record bytes in their head. A missing, changed,
 * cyclic or forward-pointing predecessor fails closed. */
export async function readMasterJournalArchiveChain(master, head, { includeRows = true } = {}) {
  validateHead(head);
  const directory = await optionalDirectory(master);
  if (!directory) throw new Error("master journal archive directory is missing");
  const names = [];
  const segments = includeRows ? [] : null;
  let exists = false;
  const seen = new Set();
  let leaf = head.archive;
  let expectedHash = head.archiveHash ?? null;
  while (leaf !== null) {
    const match = /^archive-([1-9]\d*)-(0|[1-9]\d*)\.json$/.exec(leaf);
    if (!match || Number(match[1]) !== head.epoch || seen.has(leaf)) {
      throw new Error("master journal archive segment chain is corrupt");
    }
    seen.add(leaf);
    const file = await optionalFile(directory, leaf);
    if (!file) throw new Error(`master journal archive segment ${leaf} is missing`);
    const serialized = DECODER.decode(await (await file.getFile()).arrayBuffer());
    if (expectedHash && await hash(serialized) !== expectedHash) {
      throw new Error("master journal archive segment chain hash mismatch");
    }
    const segment = await unsealMasterJournalRecord(serialized, "archive");
    if (segment.epoch !== head.epoch || !Array.isArray(segment.rows) ||
        segment.rows.length > MAX_ARCHIVE_SEGMENT_ROWS ||
        (segment.exists !== undefined && typeof segment.exists !== "boolean") ||
        (segment.exists === false && segment.rows.length > 0) ||
        (segment.index !== undefined && segment.index !== Number(match[2])) ||
        (segment.reset !== undefined && typeof segment.reset !== "boolean")) {
      throw new Error("master journal archive segment is corrupt or unbounded");
    }
    const previous = segment.previous === undefined ? null : segment.previous;
    if (previous !== null) {
      const prior = /^archive-([1-9]\d*)-(0|[1-9]\d*)\.json$/.exec(previous);
      if (!prior || Number(prior[1]) !== head.epoch || Number(prior[2]) !== Number(match[2]) - 1 ||
          segment.reset === true || !/^[0-9a-f]{64}$/.test(segment.previousHash)) {
        throw new Error("master journal archive segment predecessor is corrupt or skips a segment");
      }
    } else if ((segment.previousHash !== undefined && segment.previousHash !== null) ||
               (Number(match[2]) > 0 && segment.reset !== true)) {
      // A clear may start a new root at the NEXT unused index while the other
      // head still references the old chain. Such a root carries an explicit
      // reset witness; an accidentally missing predecessor is not a reset.
      throw new Error("master journal archive root reset witness is corrupt");
    }
    names.push(leaf);
    exists ||= segment.exists === true || segment.rows.length > 0;
    if (includeRows) segments.push(segment);
    leaf = previous;
    expectedHash = previous === null ? null : segment.previousHash;
  }
  const rows = includeRows ? segments.reverse().flatMap((segment) => structuredClone(segment.rows)) : null;
  return { names, rows, exists };
}

/** Reads only a fully published, checked checkpoint; no staged file is authority. */
export async function readMasterJournalProjection(master, { includeArchive = false } = {}) {
  const head = await readMasterJournalHead(master);
  if (!head) return null; // old profile: ordinary journal.json remains authoritative
  const directory = await optionalDirectory(master);
  const binding = {
    epoch: head.epoch, sequence: head.checkpointSequence,
    checkpoint: head.checkpoint, archive: head.archive,
  };
  if (head.archiveHash) binding.archiveHash = head.archiveHash;
  if (head.checkpointHash) binding.checkpointHash = head.checkpointHash;
  const expectedHeadHash = await hash(JSON.stringify(binding));
  if (head.sequence === head.checkpointSequence && head.lastHash !== expectedHeadHash) {
    throw new Error("master journal head/checkpoint binding is corrupt");
  }
  const checkpointFile = await optionalFile(directory, head.checkpoint);
  if (!checkpointFile) throw new Error("master journal checkpoint is missing");
  const checkpointText = DECODER.decode(await (await checkpointFile.getFile()).arrayBuffer());
  if (head.checkpointHash && await hash(checkpointText) !== head.checkpointHash) {
    throw new Error("master journal checkpoint hash mismatch");
  }
  const checkpoint = await unsealMasterJournalRecord(checkpointText, "checkpoint");
  if (checkpoint.epoch !== head.epoch || checkpoint.sequence !== head.checkpointSequence ||
      typeof checkpoint.exists !== "boolean" || !Array.isArray(checkpoint.live)) {
    throw new Error("master journal checkpoint is missing or corrupt");
  }
  // A checkpoint can contain up to 500 WHOLE rows. A different limit here
  // would let a malformed export bypass the bounded live view.
  if (checkpoint.live.length > 500) throw new Error("master journal checkpoint is unbounded");
  if (!checkpoint.exists && checkpoint.live.length > 0) throw new Error("master journal checkpoint existence contradicts retained rows");
  // Version belongs to the checkpoint generation, not necessarily the epoch:
  // compaction consumes a new durable token even when it does not add a row.
  // The absent version is accepted only for original seq-0 fixtures.
  const checkpointVersion = checkpoint.version === undefined && checkpoint.sequence === 0
    ? head.epoch : checkpoint.version;
  if (!safeInteger(checkpointVersion, head.epoch) ||
      (head.sequence === head.checkpointSequence && head.version !== checkpointVersion)) {
    throw new Error("master journal checkpoint version is corrupt");
  }
  const result = { exists: checkpoint.exists, live: structuredClone(checkpoint.live), version: head.version, head };
  let previousHash = expectedHeadHash;
  let previousVersion = checkpointVersion;
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
    } else if (frame.operation === "replace" && Array.isArray(frame.rows) && frame.rows.length <= 500 &&
        (frame.evicted === undefined || (Array.isArray(frame.evicted) && frame.evicted.length <= 1 &&
          frame.evicted.every((row) => row && typeof row === "object" && !Array.isArray(row)) &&
          JSON.stringify(frame.evicted) === JSON.stringify(result.live.slice(0, frame.evicted.length))))) {
      if (frame.evicted?.length) overflow.push(...structuredClone(frame.evicted));
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
  result.pendingOverflow = overflow;
  result.archiveCleared = archiveCleared;
  if (includeArchive) {
    const archive = await readMasterJournalArchiveChain(master, head);
    result.archive = archiveCleared ? overflow : [...archive.rows, ...overflow];
    result.archiveExists = archiveCleared ? overflow.length > 0 : (archive.exists || result.archive.length > 0);
    result.archivePaths = archive.names;
  }
  return result;
}

/** Only compaction's pure derived records may reuse an orphan. The source
 * range is already re-read and checked against the current published head;
 * compare the complete canonical sealed bytes, never repair a torn record.
 * Frames, head slots, and non-equal/source-mismatched orphans remain strict. */
async function writeOrReuseCompactionRecord(directory, name, kind, payload, source) {
  const existing = await optionalFile(directory, name);
  if (!existing) return await writeCheckedRecord(directory, name, kind, payload);
  let serialized;
  let checked;
  try {
    serialized = DECODER.decode(await (await existing.getFile()).arrayBuffer());
    checked = await unsealMasterJournalRecord(serialized, kind);
  } catch (error) {
    throw new Error(`master journal unpublished ${kind} ${name} requires explicit owner repair`, { cause: error });
  }
  if (JSON.stringify(checked.source) !== JSON.stringify(source) ||
      serialized !== await sealMasterJournalRecord(kind, payload)) {
    throw new Error(`master journal unpublished ${kind} ${name} source or payload mismatch requires explicit owner repair`);
  }
  WAL_LOG.info("verified compaction reuse", {
    kind, name, epoch: source.epoch, fromCheckpoint: source.fromCheckpoint, throughFrame: source.throughFrame,
  });
  return checked;
}

/** Fold at most 128 replayed frames into a <=500-row checkpoint and a
 * bounded immutable archive segment. The other head slot and its whole chain
 * remain available until a later publication advances it; export includes
 * the union of both slots in the meantime. This is test-only until the WAL
 * writer, receipt/CAS and clear paths are wired as one authority. */
// Internal only: a direct compaction could leave a claim older than the
// current checkpoint without the frame runner's retirement/preflight hooks.
async function stageMasterJournalCompaction(master, {
  allocateVersion, readIssuedVersion, projection = null,
} = {}) {
  if (typeof allocateVersion !== "function") throw new Error("master journal compaction requires a durable version issuer");
  const before = projection ?? await readMasterJournalProjection(master);
  if (!before) throw new Error("master journal must be cut over before compaction");
  const { head } = before;
  if (before.pendingOverflow.length > 128) throw new Error("master journal compaction overflow exceeds bounded replay");
  // Verify the entire previous archive chain before publishing a successor;
  // this is an integrity guard, not a way to compute existence. It reads
  // historic segments once per <=128-frame compaction, never per append.
  const chain = await readMasterJournalArchiveChain(master, head, { includeRows: false });
  const source = {
    epoch: head.epoch, fromCheckpoint: head.checkpointSequence, throughFrame: head.sequence,
    version: head.version, checkpoint: head.checkpoint,
    checkpointHash: head.checkpointHash ?? null,
    archive: head.archive, archiveHash: head.archiveHash ?? null,
    archiveRoot: chain.names.at(-1), archiveCount: chain.names.length,
    archiveRangeHash: await hash(JSON.stringify(chain.names)), lastHash: head.lastHash,
  };
  const sequence = head.sequence + 1;
  if (!safeInteger(sequence, 1)) throw new Error("master journal compaction sequence is unbounded");
  const directory = await optionalDirectory(master);
  const checkpoint = `checkpoint-${head.epoch}-${sequence}.json`;
  let version;
  const staged = await optionalFile(directory, checkpoint);
  if (staged) {
    let prior;
    try { prior = await readRecord(directory, checkpoint, "checkpoint"); }
    catch (error) {
      throw new Error(`master journal unpublished checkpoint ${checkpoint} requires explicit owner repair`, { cause: error });
    }
    if (JSON.stringify(prior.source) !== JSON.stringify(source) ||
        !safeInteger(prior.version, head.version + 1) ||
        typeof readIssuedVersion !== "function" ||
        await readIssuedVersion({ checkpoint, source }) !== prior.version) {
      throw new Error(`master journal unpublished checkpoint ${checkpoint} source or issued version mismatch requires explicit owner repair`);
    }
    version = prior.version;
  } else {
    // The caller must persist a checkpoint+source-specific issuance claim
    // before returning this generation. A global __gen floor cannot prove
    // that a self-consistent orphan owns THIS token on crash retry.
    version = await allocateVersion({ checkpoint, source });
  }
  if (!safeInteger(version, head.version + 1)) throw new Error("master journal compaction version must increase");
  let archive = head.archive;
  let archiveHash = head.archiveHash;
  if (before.pendingOverflow.length > 0 || before.archiveCleared) {
    const match = /^archive-([1-9]\d*)-(0|[1-9]\d*)\.json$/.exec(head.archive);
    const index = Number(match[2]) + 1;
    if (!safeInteger(index, 1)) throw new Error("master journal archive segment sequence is unbounded");
    const previous = before.archiveCleared ? null : head.archive;
    const tail = await directory.getFileHandle(head.archive);
    const previousHash = previous
      ? await hash(DECODER.decode(await (await tail.getFile()).arrayBuffer())) : null;
    archive = `archive-${head.epoch}-${index}.json`;
    await writeOrReuseCompactionRecord(directory, archive, "archive", {
      epoch: head.epoch, index, previous, previousHash, reset: before.archiveCleared,
      exists: before.pendingOverflow.length > 0,
      rows: before.pendingOverflow, source,
    }, source);
    const segment = await directory.getFileHandle(archive);
    archiveHash = await hash(DECODER.decode(await (await segment.getFile()).arrayBuffer()));
  }
  if (!archiveHash) {
    const tail = await directory.getFileHandle(archive);
    archiveHash = await hash(DECODER.decode(await (await tail.getFile()).arrayBuffer()));
  }
  await writeOrReuseCompactionRecord(directory, checkpoint, "checkpoint", {
    epoch: head.epoch, sequence, version, exists: before.exists, live: before.live, source,
  }, source);
  const checkpointFile = await directory.getFileHandle(checkpoint);
  const checkpointHash = await hash(DECODER.decode(await (await checkpointFile.getFile()).arrayBuffer()));
  const lastHash = await hash(JSON.stringify({ epoch: head.epoch, sequence, checkpoint, archive, archiveHash, checkpointHash }));
  const next = validateHead({
    ...head, epoch: head.epoch, sequence, version, checkpointSequence: sequence,
    checkpoint, archive, archiveHash, checkpointHash, lastHash,
  });
  await writeCheckedRecord(directory, HEADS[sequence % 2], "head", next);
  return next;
}

/** Writes a checked immutable operation frame then publishes one alternating
 * checked head slot. Test-only until the master store's *every* mutation and
 * export path use a single lock + projection. A failed head close is NOT an
 * acknowledgement; recovery fails closed on a corrupt present head. */
export async function stageMasterJournalFrame(master, operation, {
  allocateVersion, readIssuedVersion, preflightClaims, retireClaims,
  expectedVersion, expectedEpoch,
} = {}) {
  if (typeof allocateVersion !== "function") throw new Error("master journal frame requires a durable version issuer");
  if (!operation || typeof operation !== "object" || Array.isArray(operation) ||
      !["append", "replace", "delete", "clear"].includes(operation.operation) ||
      (operation.operation === "append" && (!operation.row || typeof operation.row !== "object" || Array.isArray(operation.row))) ||
      (operation.operation === "replace" && (!Array.isArray(operation.rows) || operation.rows.length > 500 ||
        (operation.evicted !== undefined && (!Array.isArray(operation.evicted) || operation.evicted.length > 1 ||
          operation.evicted.some((row) => !row || typeof row !== "object" || Array.isArray(row)))))) ||
      (operation.operation !== "replace" && "evicted" in operation) ||
      Object.keys(operation).some((key) => !["operation", "row", "rows", "evicted"].includes(key))) {
    throw new Error("invalid master journal frame operation");
  }
  let before = await readMasterJournalProjection(master);
  if (!before) throw new Error("master journal must be cut over before framing a write");
  // The caller already holds the master Web Lock. Compare the exact published
  // token BEFORE compaction so a stale CAS never stages a checkpoint or burns
  // a generation. Compaction is an internal part of this same requested write.
  if (expectedEpoch !== undefined && before.head.epoch !== expectedEpoch) {
    throw new Error("master journal epoch mismatch");
  }
  if (expectedVersion !== undefined && before.head.version !== expectedVersion) {
    throw new Error("master journal CAS version mismatch");
  }
  if (operation.operation === "replace" && operation.evicted?.length &&
      JSON.stringify(operation.evicted) !== JSON.stringify(before.live.slice(0, operation.evicted.length))) {
    throw new Error("master journal replacement eviction does not match the current oldest live rows");
  }
  // Never acknowledge another append if an eligible old claim could not be
  // retired. This is AFTER the caller CAS gate but BEFORE any mutation.
  if (preflightClaims) await preflightClaims(before.head);
  if (before.head.sequence - before.head.checkpointSequence >= 128) {
    await stageMasterJournalCompaction(master, { allocateVersion, readIssuedVersion, projection: before });
    before = await readMasterJournalProjection(master);
  }
  const { head } = before;
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
  if (retireClaims) {
    try { await retireClaims(next); }
    catch (error) {
      // Head publication already happened. Throwing now would make a successful
      // append look unacknowledged and allow its caller to retry a duplicate.
      WAL_LOG.warn("compaction claim retirement deferred; next write will refuse", {
        epoch: next.epoch, checkpointSequence: next.checkpointSequence, error,
      });
    }
  }
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
  if (!journalExists && journal.length > 0) throw new Error("master journal existence contradicts retained rows");
  if (!archiveExists && archive.length > 0) throw new Error("master journal archive existence contradicts retained rows");
  if (await readMasterJournalHead(master)) throw new Error("master journal is already cut over");
  const epoch = await allocateVersion();
  if (!safeInteger(epoch, 1)) throw new Error("invalid master journal cutover generation");
  const directory = await master.getDirectoryHandle(DIRECTORY, { create: true });
  const overflow = journal.slice(0, Math.max(0, journal.length - 500));
  const live = journal.slice(-500);
  const checkpoint = `checkpoint-${epoch}-0.json`;
  await writeCheckedRecord(directory, checkpoint, "checkpoint", { epoch, sequence: 0, version: epoch, exists: journalExists, live });
  const checkpointFile = await directory.getFileHandle(checkpoint);
  const checkpointHash = await hash(DECODER.decode(await (await checkpointFile.getFile()).arrayBuffer()));
  const archivedRows = [...archive, ...overflow];
  let previous = null;
  let previousHash = null;
  let archiveFile = null;
  let archiveHash = null;
  for (let index = 0; index < Math.max(1, Math.ceil(archivedRows.length / MAX_ARCHIVE_SEGMENT_ROWS)); index++) {
    const name = `archive-${epoch}-${index}.json`;
    await writeCheckedRecord(directory, name, "archive", {
      epoch, index, previous, previousHash,
      exists: archiveExists || overflow.length > 0,
      rows: archivedRows.slice(index * MAX_ARCHIVE_SEGMENT_ROWS, (index + 1) * MAX_ARCHIVE_SEGMENT_ROWS),
    });
    const file = await directory.getFileHandle(name);
    archiveHash = await hash(DECODER.decode(await (await file.getFile()).arrayBuffer()));
    previous = name;
    previousHash = archiveHash;
    archiveFile = name;
  }
  const lastHash = await hash(JSON.stringify({ epoch, sequence: 0, checkpoint, archive: archiveFile, archiveHash, checkpointHash }));
  const head = validateHead({ epoch, sequence: 0, checkpointSequence: 0, checkpoint, archive: archiveFile, archiveHash, checkpointHash, lastHash, version: epoch });
  // SINGLE PUBLICATION POINT: all earlier files were staged and read back;
  // legacy journal.json remains intact even if publication fails. A present
  // corrupt head fails closed; it is never silently treated as pre-cutover.
  await writeCheckedRecord(directory, HEADS[0], "head", head);
  return head;
}
