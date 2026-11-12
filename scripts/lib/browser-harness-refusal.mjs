// scripts/lib/browser-harness-refusal.mjs — when a REAL-BROWSER suite may refuse instead of redden.
//
// chrome-agent-platform-j5xbi, ruled by coord 2026-11-12. The problem: the seven real-browser
// journeys pass 68/68 OUTSIDE the loaded gate and fail INSIDE it — serialising them removed the
// phase's own concurrency and left the box's load, and scaled waits (up to 40s on measured absolute
// load) still could not stand the harness up while other lanes worked. The failure is
// "the machine could not start Chromium + a service worker", which is not a claim about the code.
//
// The repo already has the vocabulary for that: erxkj's ENVIRONMENTAL REFUSAL (exit 75,
// CAP_ENVIRONMENTAL_REFUSAL), which the gate classifies as a REQUEUE rather than a product red. A
// refusal certifies nothing, which is exactly why it is safe — and why it is not the skip the fleet
// banned: a skip claims the work passed, a refusal claims only that this machine could not run it.
//
// COORD'S FOUR CONDITIONS, and where each lives:
//  1. INDEPENDENT PRECONDITION EVIDENCE — a refusal needs an OBSERVED unmet precondition (no service
//     worker registered within the bound) plus the measured load/steal that produced it, recorded
//     with its timing. Never inferred from "the suite failed on a loaded box": `refuseIfStarved`
//     takes `registered` as a fact the caller observed and refuses only when it is false.
//  2. NO LAUNDERING AFTER THE HARNESS IS UP — `registered === true` can never produce a refusal, so
//     the moment the service worker exists every failure is a product red. An assertion that times
//     out after registration is a red; there is no code path here that can turn it into 75.
//  3. STARVATION MUST NOT MASK A BROKEN SUITE — a QUIET box never refuses (a broken suite on an idle
//     machine is a defect and must fail closed), and every refusal carries a per-suite running count
//     so a permanently broken suite cannot hide behind a permanently loaded neighbour.
//  4. DECLARE THE HOLE — the receipt names each refused suite individually as UNMEASURED, so the tier
//     ledger can list them per landing instead of folding them into a pass.

/** Exit code the gate reads as "environmental refusal, requeue" (erxkj). */
export const ENVIRONMENTAL_REFUSAL_EXIT = 75;

/** The marker `areAllFailuresEnvironmental`/`classifyPhaseExit` recognise. */
export const CAP_ENVIRONMENTAL_REFUSAL = "CAP_ENVIRONMENTAL_REFUSAL";

/** A 1-minute load this many times the CPU count is starvation for a browser harness. */
export const STARVED_LOAD_PER_CPU = 1.5;

/** Hypervisor steal above this means the guest is not getting the CPU it was promised. */
export const STARVED_STEAL = 0.25;

/**
 * Pure: is this machine too starved to stand a browser harness up?
 *
 * Both inputs are MEASUREMENTS the caller took at the wait, not inferences. `null` means
 * unmeasurable, and unmeasurable is never starvation: a refusal has to be justified by a fact, and
 * "we could not tell" is not one.
 *
 * @param {{ loadPerCpu?: number|null, steal?: number|null }} contention
 * @returns {boolean}
 */
export function isStarvedForBrowser({ loadPerCpu = null, steal = null } = {}) {
  const loaded = Number.isFinite(loadPerCpu) && Number(loadPerCpu) >= STARVED_LOAD_PER_CPU;
  const stolen = Number.isFinite(steal) && Number(steal) >= STARVED_STEAL;
  return loaded || stolen;
}

/**
 * Pure: the decision. Returns a refusal record or null.
 *
 * `registered` is the OBSERVED precondition: the caller waited `waitedMs` for a service worker and
 * it did not appear. If it did appear, this function cannot refuse (condition 2), whatever the load.
 *
 * @param {{
 *   suite: string,
 *   registered: boolean,
 *   waitedMs: number,
 *   boundMs: number,
 *   contention?: { loadPerCpu?: number|null, steal?: number|null, load?: number|null },
 *   priorRefusals?: number,
 * }} args
 * @returns {{ suite: string, waitedMs: number, boundMs: number, loadPerCpu: number|null, steal: number|null, load: number|null, refusals: number, receipt: string } | null}
 */
export function refuseIfStarved({
  suite,
  registered,
  waitedMs,
  boundMs,
  contention = {},
  priorRefusals = 0,
} = {}) {
  // Condition 2, first and unconditionally: the harness came up, so nothing after it can be excused.
  if (registered) return null;
  const loadPerCpu = Number.isFinite(contention.loadPerCpu) ? Number(contention.loadPerCpu) : null;
  const steal = Number.isFinite(contention.steal) ? Number(contention.steal) : null;
  const load = Number.isFinite(contention.load) ? Number(contention.load) : null;
  // Condition 3: a quiet box that cannot start a browser is a defect in the suite, not the machine.
  if (!isStarvedForBrowser({ loadPerCpu, steal })) return null;
  const refusals = Number.isFinite(priorRefusals) && priorRefusals > 0 ? Math.floor(priorRefusals) + 1 : 1;
  return {
    suite: String(suite),
    waitedMs: Number(waitedMs) || 0,
    boundMs: Number(boundMs) || 0,
    loadPerCpu,
    steal,
    load,
    refusals,
    // Condition 1's receipt: the observed fact, its timing, the measurements, and the count.
    receipt: `${CAP_ENVIRONMENTAL_REFUSAL} suite=${suite} observed=no-service-worker waitedMs=${Number(waitedMs) || 0} boundMs=${Number(boundMs) || 0} ` +
      `loadPerCpu=${loadPerCpu ?? "unmeasurable"} load=${load ?? "unmeasurable"} steal=${steal ?? "unmeasurable"} refusals=${refusals}`,
  };
}

/**
 * Condition 4: the unmeasured declaration for the tier ledger. A refused suite is named
 * individually — never folded into a pass, never into an "unmapped" coverage gap.
 *
 * @param {Array<{suite: string, refusals?: number}>} refusals
 * @returns {string|null}
 */
export function formatUnmeasuredSuites(refusals = []) {
  const named = refusals
    .map((r) => String(r?.suite ?? "").trim())
    .filter(Boolean)
    .map((suite) => {
      const count = Number(refusals.find((r) => r?.suite === suite)?.refusals);
      return Number.isFinite(count) && count > 1 ? `${suite}(refused ${count}x)` : suite;
    });
  if (!named.length) return null;
  return `fast-gate: unmeasured: ${named.join(" ")}`;
}

/**
 * Per-suite running refusal count, append-only in the evidence dir, so condition 3 has a number to
 * carry rather than a claim. Deliberately a file the caller owns: a count that lived only in a
 * process would reset every gate and never reveal a permanently-broken suite.
 *
 * @param {{ readFile?: (p: string) => string, writeFile?: (p: string, t: string) => void }} io
 * @param {string} path
 * @param {string} suite
 * @returns {number} the count AFTER recording this refusal
 */
export function countRefusals({ readFile }, path, suite) {
  let prior = 0;
  try {
    for (const line of String(readFile(path)).split("\n")) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line)?.suite === suite) prior += 1;
      } catch { /* a torn line must not lose what we can still prove */ }
    }
  } catch { /* no ledger yet */ }
  return prior;
}

export function recordRefusal(
  { readFile, writeFile },
  path,
  suite,
) {
  let prior = 0;
  try {
    const text = readFile(path);
    for (const line of String(text).split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.suite === suite) prior += 1;
      } catch { /* a torn line must not lose the count we can still prove */ }
    }
  } catch { /* no ledger yet: this is the first refusal */ }
  const next = prior + 1;
  try {
    writeFile(path, `${JSON.stringify({ suite: String(suite), at: new Date().toISOString() })}\n`);
  } catch { /* the count is best-effort; the receipt still carries what we observed */ }
  return next;
}
