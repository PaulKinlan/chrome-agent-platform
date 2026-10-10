// STAGED one-authority mapping for the existing journal function signatures.
// Product memory.js deliberately does NOT import/call this module yet: a
// published head (including one restored from a backup) must still refuse
// writes until EVERY master mutation, recovery and repair route is complete.

export function createStagedMasterJournalProductRoutes(withStoreTransaction) {
  if (typeof withStoreTransaction !== "function") {
    throw new TypeError("staged journal routes require a store transaction authority");
  }
  const master = async (store, operation) => {
    if (!store?.isMaster) throw new Error("staged WAL journal route requires a master store");
    return await withStoreTransaction(store, async (tx) => {
      if (!tx?.isMaster || !tx.masterJournal) {
        throw new Error("staged WAL journal route requires a master transaction");
      }
      // A test invoking this facade on a legacy profile must NEVER cause an
      // implicit cutover or silently interpret pre-head residue as authority.
      if (!await tx.masterJournal.head()) {
        throw new Error("staged WAL journal route requires a published head");
      }
      return await operation(tx.masterJournal);
    });
  };
  return Object.freeze({
    append: async (store, entry, guard = null, idempotencyExecutionId = null) =>
      await master(store, (wal) => wal.append(entry, { guard, idempotencyExecutionId })),
    appendWithReceipt: async (store, entry, guard = null) =>
      await master(store, (wal) => wal.appendWithReceipt(entry, { guard })),
    appendOnce: async (store, entry, guard = null, executionId = entry?.executionId) => {
      if (!executionId) throw new Error("journalAppendOnce requires executionId");
      return await master(store, (wal) => wal.append({ ...entry, executionId },
        { guard, idempotencyExecutionId: executionId }));
    },
    compensate: async (store, receipt, guard = null) => {
      if (!receipt || receipt.schemaVersion !== 1 || receipt.key !== "journal" || !receipt.executionId) {
        throw new Error("invalid journal compensation receipt");
      }
      return await master(store, (wal) => receipt.wal
        ? wal.compensate(receipt, { guard })
        : { ok: false, compensated: false, preserved: true, reason: "legacy_receipt_after_cutover" });
    },
    cancel: async (store, entry, executionId = entry?.executionId) => {
      if (!executionId) throw new Error("journalCommitCancellation requires executionId");
      return await master(store, (wal) => wal.cancel(entry, executionId));
    },
  });
}
