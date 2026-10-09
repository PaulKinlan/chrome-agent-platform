// A cutover fence must survive the restore recovery path, which deliberately
// auto-clears cap:restoreFence after an abandoned restore. No production route
// arms or disarms this key while the one-authority WAL writer remains OFF.
export const MASTER_JOURNAL_CUTOVER_FENCE_KEY = "cap:masterJournalCutoverFence";

/** Only an explicit owner repair may remove a PRESENT cutover key, even if its
 * value is malformed. Read failures are not evidence that admission is safe. */
export async function readJournalAdmissionFence(local = globalThis.chrome?.storage?.local) {
  if (!local?.get) throw new Error("journal admission fence storage is unavailable");
  const restore = await local.get("cap:restoreFence");
  const cutover = await local.get(MASTER_JOURNAL_CUTOVER_FENCE_KEY);
  if (!restore || typeof restore !== "object" || Array.isArray(restore) ||
      !cutover || typeof cutover !== "object" || Array.isArray(cutover)) {
    throw new Error("journal admission fence storage is unreadable");
  }
  if (Object.hasOwn(cutover, MASTER_JOURNAL_CUTOVER_FENCE_KEY)) return "master_journal_cutover";
  return restore["cap:restoreFence"] ? "restore" : null;
}
