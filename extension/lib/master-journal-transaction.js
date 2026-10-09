// Staged master-only WAL journal transactions. The caller MUST hold the
// cap:master-journal exclusive Web Lock for the entire read/guard/frame/read
// transaction. NOT a product writer: memory.js still refuses all WAL writes
// until every master mutation, receipt, cancellation and recovery seam is wired.
import { readMasterJournalProjection, stageMasterJournalFrame } from "./master-journal-wal.js";

const MAX_LIVE = 500;
const bound = (rows) => rows.slice(-MAX_LIVE);
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function currentProjection(master) {
  const projection = await readMasterJournalProjection(master);
  if (!projection) throw new Error("master journal transaction requires a checked WAL head");
  return projection;
}

function stateOf(projection) {
  return {
    exists: projection.exists,
    value: projection.exists ? structuredClone(projection.live) : null,
    version: projection.version,
    epoch: projection.head.epoch,
  };
}

function frameOptions(issuer, projection) {
  return {
    allocateVersion: issuer.allocateVersion,
    readIssuedVersion: issuer.readIssuedVersion,
    expectedVersion: projection.version,
    expectedEpoch: projection.head.epoch,
  };
}

function replacement(exists, rows) {
  return exists ? { operation: "replace", rows } : { operation: "delete" };
}

/** One append, one published head; eviction belongs to the same frame. */
export async function appendMasterJournalWithReceipt(master, entry, {
  allocateVersion, readIssuedVersion, guard = null, idempotencyExecutionId = null,
} = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !entry.executionId) {
    throw new Error("master journal receipt append requires executionId");
  }
  const issuer = { allocateVersion, readIssuedVersion };
  const before = await currentProjection(master);
  const pre = stateOf(before);
  const original = before.exists ? before.live : [];
  if (idempotencyExecutionId && original.some((row) =>
    row?.executionId === idempotencyExecutionId && row?.type === (entry.type ?? "result"))) {
    return {
      schemaVersion: 1, key: "journal", executionId: String(entry.executionId),
      preState: pre, postState: structuredClone(original), writeVersion: before.version,
      appended: false, wal: { epoch: before.head.epoch, sequence: before.head.sequence,
        operationId: null, writeVersion: before.version, checkpointSequenceAtAppend: before.head.checkpointSequence,
        eviction: [] },
    };
  }
  const row = { ts: Date.now(), ...entry };
  if (guard) await guard();
  const head = await stageMasterJournalFrame(master, { operation: "append", row }, frameOptions(issuer, before));
  const after = await currentProjection(master);
  if (head.version !== after.version) throw new Error("master journal append publication changed before receipt");
  if (guard) {
    try { await guard(); } catch (error) {
      // This is an undo of the live append, NOT a retraction of historical
      // eviction. A failed guard's forbidden row must never remain live.
      try {
        await stageMasterJournalFrame(master,
          replacement(pre.exists && error?.genMismatch !== true, original),
          frameOptions(issuer, after));
      } catch (undoError) {
        throw new AggregateError([error, undoError], "master journal post-commit guard failed; live undo unverified");
      }
      throw error;
    }
  }
  const entries = after.live;
  if (entries.at(-1)?.executionId !== String(entry.executionId)) {
    throw new Error("master journal receipt append lost its actual executionId");
  }
  const eviction = original.length >= MAX_LIVE ? [structuredClone(original[0])] : [];
  return {
    schemaVersion: 1, key: "journal", executionId: String(entry.executionId),
    preState: pre, postState: structuredClone(entries), writeVersion: head.version,
    appended: true,
    wal: { epoch: head.epoch, sequence: head.sequence,
      operationId: `${head.epoch}:${head.sequence}`, writeVersion: head.version,
      checkpointSequenceAtAppend: head.checkpointSequence, eviction },
  };
}

/** Restore the live ring by the legacy suffix-lineage proof, never retracting
 * archived evictions. A changed epoch/version fails BEFORE any issued token. */
export async function compensateMasterJournalReceipt(master, receipt, {
  allocateVersion, readIssuedVersion, guard = null,
} = {}) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.key !== "journal" ||
      !receipt.executionId || !receipt.wal || !Number.isSafeInteger(receipt.wal.epoch) ||
      receipt.wal.writeVersion !== receipt.writeVersion ||
      !Array.isArray(receipt.postState) ||
      !receipt.preState || (receipt.preState.exists && !Array.isArray(receipt.preState.value))) {
    throw new Error("invalid master journal compensation receipt");
  }
  const issuer = { allocateVersion, readIssuedVersion };
  const fence = async () => {
    if (!guard) return null;
    try { await guard(); return null; }
    catch (error) {
      return { ok: false, compensated: false, preserved: true,
        reason: error?.genMismatch ? "generation_mismatch" : "journal_fence_failed" };
    }
  };
  const refused = await fence();
  if (refused) return refused;
  const projection = await currentProjection(master);
  if (projection.head.epoch !== receipt.wal.epoch ||
      receipt.preState.epoch !== receipt.wal.epoch) {
    return { ok: false, compensated: false, preserved: true, reason: "generation_mismatch" };
  }
  const current = stateOf(projection);
  if (receipt.compensatedState &&
      current.version === receipt.compensatedState.version &&
      current.exists === receipt.compensatedState.exists &&
      sameJson(current.value, receipt.compensatedState.value)) {
    return { ok: true, compensated: true, idempotent: true };
  }
  const pre = receipt.preState;
  if (current.exists === pre.exists && sameJson(current.value, pre.value)) {
    if (receipt.appended === false && current.version === receipt.writeVersion) {
      receipt.compensatedState = structuredClone(current);
      return { ok: true, compensated: true, idempotent: true };
    }
    return { ok: false, compensated: false, preserved: true, reason: "journal_version_mismatch" };
  }
  if (!current.exists || !Array.isArray(current.value)) {
    return { ok: false, compensated: false, preserved: true, reason: "journal_state_unprovable" };
  }
  let next;
  if (current.version === receipt.writeVersion && sameJson(current.value, receipt.postState)) {
    next = pre.exists ? structuredClone(pre.value) : undefined;
  } else {
    if (sameJson(current.value, receipt.postState)) {
      return { ok: false, compensated: false, preserved: true, reason: "journal_version_mismatch" };
    }
    let matched = -1;
    for (let removed = 0; removed < receipt.postState.length; removed++) {
      const suffix = receipt.postState.slice(removed);
      if (suffix.length <= current.value.length &&
          sameJson(current.value.slice(0, suffix.length), suffix)) {
        matched = removed;
        break;
      }
    }
    if (matched < 0) {
      return { ok: false, compensated: false, preserved: true, reason: "journal_concurrency_unprovable" };
    }
    const later = current.value.slice(receipt.postState.length - matched);
    if (!sameJson(bound([...receipt.postState, ...later]), current.value)) {
      return { ok: false, compensated: false, preserved: true, reason: "journal_version_mismatch" };
    }
    const foreignLater = later.filter((row) => row?.executionId !== receipt.executionId);
    next = bound([...(pre.exists ? pre.value : []), ...foreignLater]);
  }
  const preCommitRefusal = await fence();
  if (preCommitRefusal) return preCommitRefusal;
  const head = await stageMasterJournalFrame(master,
    replacement(next !== undefined, next), frameOptions(issuer, projection));
  const postCommitRefusal = await fence();
  if (postCommitRefusal) {
    try {
      await stageMasterJournalFrame(master, replacement(current.exists, current.value), {
        ...issuer, expectedEpoch: head.epoch, expectedVersion: head.version,
      });
    } catch (undoError) {
      throw new AggregateError([new Error(postCommitRefusal.reason), undoError],
        "master journal compensation fence failed; undo unverified");
    }
    return postCommitRefusal;
  }
  receipt.compensatedState = stateOf(await currentProjection(master));
  return { ok: true, compensated: true, idempotent: false,
    concurrentRowsPreserved: current.version !== receipt.writeVersion };
}

/** One replacement frame carries both the cancellation row and at most one
 * oldest-row eviction. No separate archive key write can race the head. */
export async function cancelMasterJournalExecution(master, entry, executionId = entry?.executionId, {
  allocateVersion, readIssuedVersion,
} = {}) {
  if (!executionId) throw new Error("master journal cancellation requires executionId");
  const before = await currentProjection(master);
  const original = before.exists ? before.live : [];
  const kept = original.filter((row) => !(row?.executionId === executionId &&
    ["result", "cancelled"].includes(row?.type)));
  kept.push({ ts: Date.now(), ...entry, type: "cancelled", executionId, cancelled: true });
  const evicted = kept.length > MAX_LIVE ? kept.slice(0, kept.length - MAX_LIVE) : [];
  const rows = bound(kept);
  await stageMasterJournalFrame(master, { operation: "replace", rows, evicted },
    frameOptions({ allocateVersion, readIssuedVersion }, before));
  return rows;
}
