// Web Locks synchronize master-journal authority writers across the extension's
// service worker and owner Options page. This is NOT a whole-profile snapshot
// lock: other stores retain their existing backup semantics.
export const MASTER_JOURNAL_WEB_LOCK = "cap:master-journal";

export async function withMasterJournalWebLock(fn, locks = globalThis.navigator?.locks) {
  if (typeof fn !== "function") throw new TypeError("master journal lock requires a callback");
  if (locks?.request) {
    return await locks.request(MASTER_JOURNAL_WEB_LOCK, { mode: "exclusive" }, fn);
  }
  // Deno's OPFS fakes have no Web Locks. Do not silently degrade inside a real
  // extension context: it would allow a raw export to race with a WAL pointer.
  if (typeof Deno !== "undefined") return await fn();
  throw new Error("master journal Web Lock unavailable; refusing an unprotected write or export");
}
