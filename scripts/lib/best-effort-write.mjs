// scripts/lib/best-effort-write.mjs — chrome-agent-platform-yqhb2.
//
// A best-effort catch around a WRITE is not graceful degradation, it is silent data loss. On
// 2026-11-12 the refusal ledger appended to a path that was a DIRECTORY, every append raised
// EISDIR, and a `catch { /* best-effort */ }` swallowed it: the receipt for unmeasured suites went
// silent, and the only symptom was a `persistentCount=0` field nobody asserted on. The fleet had
// spent the night removing "unmeasured reported as pass"; this was the same failure one layer
// lower, where the ABSENCE of a record looks like "nothing to report".
//
// The rule this module enforces: a write whose failure is discarded must be VISIBLE. Every attempt
// increments `attempted`; every success increments `written`; every failure increments `failed` and
// LOGS. Then a silent zero and a real zero are different numbers, which is the whole point — a
// counter nobody can distinguish from success is not evidence.
//
// What it deliberately does NOT do: crash, or throw. Coord's constraint on the bead is explicit —
// "do not fix it by removing the catch and crashing; an unwritable ledger should degrade loudly
// into a refusal". So `bestEffortWrite` never throws, and `requireWrite` (for writes whose loss
// changes a VERDICT) reports a refusal instead.

/** A visible counter pair: how many writes we tried, and how many actually landed. */
export function createWriteCounters() {
  return { attempted: 0, written: 0, failed: 0 };
}

/**
 * One shape for "we tried to write this and it may not have landed".
 * @param {{ attempted: number, written: number, failed: number }} counters
 * @returns {{ attempted: number, written: number, failed: number, silent: number }}
 */
export function writeReport(counters) {
  const attempted = Number(counters?.attempted) || 0;
  const written = Number(counters?.written) || 0;
  const failed = Number(counters?.failed) || 0;
  // `silent` is the number of attempts we cannot account for at all — the state the EISDIR bug
  // produced. It must be 0 for any write path we claim to understand.
  return { attempted, written, failed, silent: Math.max(0, attempted - written - failed) };
}

/**
 * Write, counting the attempt, the success and the failure. Never throws, never stays quiet.
 *
 * @param {{
 *   write: (path: string, text: string) => unknown,
 *   counters?: { attempted: number, written: number, failed: number },
 *   label?: string,
 *   log?: (message: string) => void,
 * }} io
 * @param {string} path
 * @param {string} text
 * @returns {{ ok: boolean, error?: Error }}
 */
export function bestEffortWrite({ write, counters = null, label = null, log = console.error }, path, text) {
  // NB: `label` defaults to null, not to `path` — a default parameter may not reference a LATER
  // parameter, and doing so throws "Cannot access 'path' before initialization" at CALL time, which
  // is the kind of error a test finds and a reader would not predict.
  const subject = label ?? path;
  if (counters) counters.attempted += 1;
  try {
    write(path, text);
    if (counters) counters.written += 1;
    return { ok: true };
  } catch (error) {
    if (counters) counters.failed += 1;
    // LOUD: the reason a swallowed write is dangerous is that nobody learns it happened.
    log(`[best-effort-write] FAILED ${subject} (${path}): ${error?.code ?? error?.name ?? "error"}: ${error?.message ?? ""}`.trim());
    return { ok: false, error };
  }
}

/**
 * A write whose loss would change a VERDICT (a refusal record, an evidence receipt). It still must
 * not crash the gate: an unwritable evidence tree means "this machine could not record the result",
 * which is an environmental refusal (75), not a red and not silence.
 *
 * @param {{
 *   write: (path: string, text: string) => unknown,
 *   counters?: { attempted: number, written: number, failed: number },
 *   label?: string,
 *   log?: (message: string) => void,
 *   refusalReceipt?: string,
 * }} io
 * @param {string} path
 * @param {string} text
 * @returns {{ ok: boolean, refused: boolean, error?: Error }}
 */
export function requireWrite(io, path, text) {
  const result = bestEffortWrite(io, path, text);
  if (result.ok) return { ok: true, refused: false };
  // The caller decides HOW to leave (exit 75, a refusal receipt); this only says it must.
  return { ok: false, refused: true, error: result.error };
}
