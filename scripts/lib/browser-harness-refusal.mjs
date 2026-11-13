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

import { loadavg } from "node:os";
import { bestEffortWrite } from "./best-effort-write.mjs";
import { currentLoadPerCpu, currentStealFractionSync, MAX_LOAD_SCALE, stealScaleComponent } from "./serial-phase.mjs";

const loadAvg = () => loadavg()[0];

/** The machine's current ABSOLUTE 1-minute load (1 when it cannot be read). */
export function currentAbsoluteLoad() {
  try {
    const load = loadAvg();
    return Number.isFinite(load) && load > 1 ? Number(load) : 1;
  } catch {
    return 1;
  }
}

/**
 * A REAL-BROWSER readiness wait is a deadline like any other, so it scales with measured contention.
 *
 * ABSOLUTE load, not load per CPU, and that distinction was measured: on this 8-CPU box at absolute
 * load 9.8 the per-CPU reading is 1.22 — a factor that rounds almost to one while five browser
 * suites were reddening on one gate. Same reasoning as kzy5x for the cold-boot grace: what makes a
 * browser start slowly is how many runnable tasks contend. The ceiling is MAX_LOAD_SCALE (x4), shared
 * with serialFileTimeoutMs so the repo cannot hold two answers to "how slow may this machine make us".
 *
 * @param {{ base?: number, load?: number|null, loadPerCpu?: number|null, steal?: number|null }} [options]
 * @returns {number}
 */
export function browserReadyTimeoutMs({ base = 10_000, load = null, loadPerCpu = null, steal = null } = {}) {
  const absolute = Number.isFinite(load) && Number(load) > 1 ? Number(load) : 1;
  const perCpu = Number.isFinite(loadPerCpu) && Number(loadPerCpu) > 1 ? Number(loadPerCpu) : 1;
  const scale = Math.min(Math.max(absolute, perCpu, stealScaleComponent(steal)), MAX_LOAD_SCALE);
  return Math.round(base * scale);
}

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
 *   observed?: string,
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
  observed = "no-service-worker",
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
    receipt: `${CAP_ENVIRONMENTAL_REFUSAL} suite=${suite} observed=${observed} waitedMs=${Number(waitedMs) || 0} boundMs=${Number(boundMs) || 0} ` +
      `loadPerCpu=${loadPerCpu ?? "unmeasurable"} load=${load ?? "unmeasurable"} steal=${steal ?? "unmeasurable"} refusals=${refusals}`,
  };
}

// amupt: there is exactly ONE renderer for condition 4 and it lives in gate-manifest.mjs
// (`formatGateUnmeasured`, beside GATE_UNMEASURED_PREFIX and the other `fast-gate:` markers). A second
// copy here — same prefix, same `(refused Nx)` shape, pinned by its own test — was two answers to "how
// is unmeasured rendered": identical output today, silent divergence the first time either side was
// edited. The consumer (emitGateLedger) was already the gate-manifest one, so this is the copy that
// goes; the prefix constant is NOT redeclared anywhere.

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
  { readFile, writeFile, ensureParent, counters = { attempted: 0, written: 0, failed: 0 } },
  path,
  suite,
) {
  // A ledger whose directory does not exist writes nothing and reports nothing — the reviewer
  // measured exactly that (a refusal with persistentCount=0). The caller passes ensureParent when
  // it can create the directory; if it cannot, the count stays best-effort and the receipt says so
  // by carrying the count it could prove.
  try {
    ensureParent?.(path);
  } catch { /* best-effort: a read-only evidence dir must not fail a suite */ }
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
  // yqhb2: this write used to be wrapped in a bare catch, so an EISDIR (the path was a DIRECTORY —
  // durableDir creates one) was discarded and the receipt went silent. It now goes through the
  // visible-counter primitive: the attempt, the success and the failure are all counted, and a
  // failure is logged. The receipt still carries what we OBSERVED, so the refusal itself is honest;
  // what changed is that "we could not record it" is no longer indistinguishable from "there was
  // nothing to record".
  counters.attempted += 1;
  const outcome = bestEffortWrite({
    write: writeFile,
    label: `refusal ledger for ${suite}`,
    log: (message) => console.error(message),
  }, path, `${JSON.stringify({ suite: String(suite), at: new Date().toISOString() })}\n`);
  if (outcome.ok) counters.written += 1;
  else {
    counters.failed += 1;
    counters.lastError = String(outcome.error?.code ?? outcome.error?.message ?? "write-failed");
  }
  return next;
}

/**
 * Read the ledger back: [{ suite, refusals }], one row per suite seen. This is the READER the gate
 * uses, exported so a test can drive a REAL file through the same code path the runner does — a
 * round trip that is proven at the io boundary but not through the actual reader is how the
 * persistentCount=0 defect survived review once already.
 *
 * An unreadable or absent ledger returns [] rather than throwing: the honest outcome is "we cannot
 * prove a refusal was recorded", and the caller then adds no line instead of inventing one.
 *
 * @param {{ readFile?: (p: string) => string, exists?: (p: string) => boolean }} io
 * @param {string} path
 * @param {{ since?: number|null }} [options] epoch-ms lower bound; rows older or untimed are excluded
 * @returns {Array<{suite: string, refusals: number}>}
 */
export function refusalsFromLedger({ readFile, exists } = {}, path, { since = null } = {}) {
  try {
    if (typeof exists === "function" && !exists(path)) return [];
    const text = String(typeof readFile === "function" ? readFile(path) : "");
    const counts = new Map();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row?.suite === "string" && row.suite.trim()) {
          // dqk0e: the ledger is append-only across runs, so a row from a PREVIOUS run must not
          // declare a suite unmeasured on a run where it never refused — the reviewer reproduced
          // exactly that (a bound ledger made two clean runs report a suite as unmeasured). `since`
          // scopes the answer to this run; the total count is still available for condition (3).
          if (since) {
            const at = Date.parse(String(row?.at ?? ""));
            if (!Number.isFinite(at) || at < since) continue;
          }
          counts.set(row.suite, (counts.get(row.suite) ?? 0) + 1);
        }
      } catch { /* a torn line names no suite: never guess one */ }
    }
    return [...counts].map(([suite, refusals]) => ({ suite, refusals }));
  } catch {
    return [];
  }
}

/**
 * Leave with the environmental refusal AFTER cleaning up. `Deno.exit()` does not run `finally`
 * blocks, so exiting from inside a test body leaks the Chrome process, its profile and any server the
 * suite opened (rev-j5xbi2 measured exactly that). Callers pass the cleanup they would otherwise
 * leave to `finally`; it runs first, then the receipt is printed and the process leaves with 75.
 *
 * @param {{ receipt: string, cleanup?: () => unknown, exit?: (code: number) => never }} args
 * @returns {Promise<never>}
 */
export async function exitWithRefusal({ receipt, cleanup = null, exit = (code) => Deno.exit(code) }) {
  try {
    await cleanup?.();
  } catch { /* a failing cleanup must not turn a refusal into a red */ }
  if (receipt) console.error(receipt);
  return exit(ENVIRONMENTAL_REFUSAL_EXIT);
}

/**
 * ONE wiring for a real-browser suite's readiness step: wait for the extension's service worker under
 * a contention-scaled bound, and refuse (exit 75) ONLY when the precondition was OBSERVED unmet AND
 * starvation was MEASURED. The reference implementation was inline in
 * tests/sandbox-egress-confinement.test.ts (j5xbi); six more journeys need the same four conditions,
 * and six hand-copies of this branch is six chances to drop one — the drift shape the unmeasured-line
 * bead (amupt) exists to stop.
 *
 * The contract, in the order this function enforces it:
 *  1. The bound scales with measured contention (`browserReadyTimeoutMs`), so a starved box gets the
 *     time it needs before anyone calls it a failure.
 *  2. `registered` is what the CALLER observed — this function only reports that `cdp.serviceWorker`
 *     returned null within the bound. It never infers "the machine was too slow" from a failure.
 *  3. A quiet box that cannot register a service worker gets `null` back, NOT a refusal: the caller's
 *     `assert(sw, …)` then reds the suite as a PRODUCT failure, which is the defect it is.
 *  4. A refusal is recorded in the append-only per-suite ledger (so the count rises across gates) and
 *     the process leaves 75 with `cleanup` already run.
 *
 * @param {{
 *   suite: string,
 *   cdp?: { serviceWorker: (args: { timeoutMs: number, match?: ((t: any) => boolean)|null }) => Promise<any> }|null,
 *   wait?: ((boundMs: number) => Promise<any|null>)|null,
 *   match?: ((t: any) => boolean)|null,
 *   base?: number,
 *   contention?: { load?: number|null, loadPerCpu?: number|null, steal?: number|null }|null,
 *   ledgerIo?: { readFile: (p: string) => string, writeFile: (p: string, t: string) => void }|null,
 *   ledgerPath?: string|null,
 *   cleanup?: (() => unknown)|null,
 *   exit?: (code: number) => never,
 *   observed?: string,
 * }} args
 * @returns {Promise<any|null>} the service worker target, or null when none registered and no refusal applies
 */
export async function awaitServiceWorkerOrRefuse({
  suite,
  cdp = null,
  wait = null,
  match = null,
  base = 10_000,
  contention = null,
  ledgerIo = null,
  ledgerPath = null,
  cleanup = null,
  exit = undefined,
  observed = "no-service-worker",
} = {}) {
  const measured = contention ?? {
    load: currentAbsoluteLoad(),
    loadPerCpu: currentLoadPerCpuSafe(),
    steal: currentStealFractionSyncSafe(),
  };
  // Condition 1's timing: the SAME number is the wait and the bound the receipt carries, so a
  // receipt can never claim a bound the wait did not use (the f8li1 leg pins that identity).
  const boundMs = browserReadyTimeoutMs({ base, load: measured.load ?? null, loadPerCpu: measured.loadPerCpu ?? null, steal: measured.steal ?? null });
  // Two readiness shapes exist in the tree: `cdp.serviceWorker({timeoutMs})` (the reference suite) and
  // `waitForServiceWorker(send, {timeoutMs})` for suites that drive raw CDP. Both are given the SAME
  // scaled bound, and neither may report a torn/partial result as "registered".
  const sw = wait
    ? await wait(boundMs)
    : await cdp.serviceWorker({ timeoutMs: boundMs, ...(match ? { match } : {}) });
  if (sw) return sw; // condition 2: the harness is up, so nothing downstream may be excused
  const refusal = refuseIfStarved({
    suite,
    registered: false,
    waitedMs: boundMs,
    boundMs,
    contention: measured,
    priorRefusals: ledgerIo && ledgerPath ? countRefusals(ledgerIo, ledgerPath, suite) : 0,
    observed,
  });
  if (!refusal) return null; // condition 3: a quiet box that cannot start a browser is a PRODUCT red
  if (ledgerIo && ledgerPath) recordRefusal(ledgerIo, ledgerPath, suite);
  return exitWithRefusal({ receipt: refusal.receipt, cleanup, ...(exit ? { exit } : {}) });
}

/** Local wrappers so this module stays free of serial-phase's optional-argument surface. */
function currentLoadPerCpuSafe() {
  try {
    return currentLoadPerCpu();
  } catch {
    return null;
  }
}

function currentStealFractionSyncSafe() {
  try {
    return currentStealFractionSync();
  } catch {
    return null;
  }
}
