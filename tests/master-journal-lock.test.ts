// @ts-nocheck — inject navigator.locks and OPFS handles to drive the owner export.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { executeOptionsExport } from "../extension/lib/backup-export.js";
import { MASTER_JOURNAL_WEB_LOCK, withMasterJournalWebLock } from "../extension/lib/master-journal-lock.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

Deno.test("master journal Web Lock serializes an owner export's raw inventory with a writer", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const inventoryEntered = deferred();
  const releaseInventory = deferred();
  const names = [];
  let last = Promise.resolve();
  const locks = {
    request(name, options, fn) {
      names.push({ name, mode: options.mode });
      const current = last.then(fn);
      last = current.catch(() => {});
      return current;
    },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });
  try {
    const root = {
      async *values() {
        inventoryEntered.resolve();
        await releaseInventory.promise;
      },
      async getFileHandle() {
        return {
          createWritable: async () => new WritableStream(),
          getFile: async () => new Blob([new Uint8Array(512)]),
        };
      },
      removeEntry: async () => {},
    };
    const exportRun = executeOptionsExport({
      storageRoot: root,
      showPicker: null,
      createDownloadUrl: () => "blob:journal-lock-test",
      revokeDownloadUrl: () => {},
      triggerDownload: () => {},
      kvGet: async () => ({}),
      alarms: { getAll: async () => [] },
      // The outer restore lock remains the owner's existing protocol. The
      // journal lock must begin AFTER that acquisition and end after streaming.
      lockAcquirer: async (fn) => fn(),
    });
    await inventoryEntered.promise;
    let writerEntered = false;
    const writer = withMasterJournalWebLock(async () => { writerEntered = true; });
    assertEquals(writerEntered, false, "a master writer cannot change the journal while raw file inventory/streaming is in progress");
    releaseInventory.resolve();
    await exportRun;
    await writer;
    assertEquals(writerEntered, true);
    assertEquals(names, [
      { name: MASTER_JOURNAL_WEB_LOCK, mode: "exclusive" },
      { name: MASTER_JOURNAL_WEB_LOCK, mode: "exclusive" },
    ]);
  } finally {
    releaseInventory.resolve();
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});

Deno.test("Deno OPFS fake may omit Web Locks; invalid callback still refuses", async () => {
  // This unit suite is Deno, so lack of navigator.locks intentionally falls
  // back only here. Browser builds have no Deno global and must fail closed.
  assertEquals(await withMasterJournalWebLock(async () => "fake-opfs", null), "fake-opfs");
  await assertRejects(() => withMasterJournalWebLock(null), TypeError, "callback");
});
