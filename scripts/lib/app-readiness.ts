// scripts/lib/app-readiness.ts — shared readiness primitive for journey/KAT harnesses (chrome-agent-platform-iksuc).
//
// Invariant: harnesses must NOT interact with an unhydrated app page (NTP, sidepanel, options).
// Pre-hydration clicks silently no-op because event listeners are not installed yet, leading to
// false INCONCLUSIVE results and wasted runs.
//
// This module provides:
// 1. APP_READY_ATTR: standard readiness marker if set by an app page.
// 2. APP_NEVER_BECAME_READY: the NAMED failure state reported when readiness wait times out.
// 3. waitForAppReady(): polls for the named app-ready signal or hydration state with bounded wait
//    and throws `app never became ready` on timeout.
// 4. interactWhenReady(): waits for app readiness before executing an interaction.

import { isCdpEvaluateTimeout } from "./quiet-window.ts";
import { CdpEvaluateLoadTimeoutError, CdpEvaluateIdleTimeoutError } from "./kat-evaluate.ts";

export const APP_READY_ATTR = "data-cap-app-ready";
export const APP_NEVER_BECAME_READY = "app never became ready";

export const APP_READY_EXPRESSION = `(() => {
  try {
    const doc = document;
    if (!doc) return { ready: false, reason: "no document" };

    if (doc.documentElement?.dataset?.capAppReady === "true" ||
        doc.documentElement?.getAttribute?.("${APP_READY_ATTR}") === "true") {
      return { ready: true, signal: "${APP_READY_ATTR}" };
    }

    const path = (location.pathname || "").toLowerCase();

    // NTP Hub: interactive once stage2B mounts jobs-board and named-agents container has hydrated
    if (path.includes("/ntp/ntp.html") || path.endsWith("/ntp.html") || path.endsWith("/ntp/")) {
      const jobsBoard = doc.querySelector("#jobs-board-host jobs-board");
      const namedAgents = doc.querySelector("#named-agents");
      const namedHydrated = !!namedAgents && namedAgents.children.length > 0;
      if (jobsBoard && namedHydrated) {
        return { ready: true, signal: "ntp-hydrated" };
      }
      return { ready: false, reason: "ntp hydration pending", jobsBoard: !!jobsBoard, namedHydrated };
    }

    // Sidepanel: interactive once custom elements are defined, tabs are wired, and composer is in DOM
    if (path.includes("/sidepanel/sidepanel.html") || path.endsWith("/sidepanel.html")) {
      const composer = doc.getElementById("page-composer") || doc.getElementById("agent-composer") || doc.querySelector("agent-composer");
      const tabAgents = doc.getElementById("tab-agents");
      const customElementsReady = typeof customElements !== "undefined" &&
        !!customElements.get("agent-composer") &&
        !!customElements.get("agent-picker");
      if (composer && tabAgents && customElementsReady && doc.readyState === "complete") {
        return { ready: true, signal: "sidepanel-hydrated" };
      }
      return { ready: false, reason: "sidepanel hydration pending", composer: !!composer, tabAgents: !!tabAgents, customElementsReady };
    }

    // Options: interactive once document is complete, active section is mounted,
    // and target controls for that section have hydrated (not just static nav header buttons; z4tzw).
    if (path.includes("/options/options.html") || path.endsWith("/options.html")) {
      if (doc.readyState !== "complete") {
        return { ready: false, reason: "options document not complete", readyState: doc.readyState };
      }
      const rawHash = (location.hash || "").replace(/^#/, "").toLowerCase();
      const targetSection = rawHash || "providers";
      const targetPanel = doc.getElementById(targetSection) || (doc.querySelector && doc.querySelector("section#" + targetSection));

      if (targetSection === "board-permissions") {
        const agentSelect = doc.getElementById("board-deny-agent");
        const addBtn = doc.getElementById("board-deny-add-btn");
        const panelActive = !!targetPanel && (targetPanel.classList?.contains?.("active") || targetPanel.dataset?.active === "true");
        // Populated once populateBoardDenyAgents sets agentSelect.providers array with at least Hub and agent entries
        const providersHydrated = !!agentSelect && (Array.isArray(agentSelect.providers) ? agentSelect.providers.length > 0 : ((agentSelect.getAttribute?.("providers") || "").length > 2));
        if (agentSelect && addBtn && panelActive && providersHydrated) {
          return { ready: true, signal: "options-hydrated" };
        }
        return {
          ready: false,
          reason: "options board permissions hydration pending",
          agentSelect: !!agentSelect,
          addBtn: !!addBtn,
          panelActive,
          providersHydrated,
        };
      }

      if (targetSection === "providers") {
        // Must find genuinely rendered provider cards, never just the error/retry button or dead selectors (97qd6)
        const hasCards = (doc.querySelectorAll?.("#provider-panels .provider-card")?.length ?? 0) > 0;
        if (hasCards) {
          return { ready: true, signal: "options-hydrated" };
        }
        return { ready: false, reason: "options providers hydration pending" };
      }

      // Generic options section: target panel must be active and have internal controls
      const panelActive = !!targetPanel && (targetPanel.classList?.contains?.("active") || targetPanel.dataset?.active === "true");
      const hasPanelControls = !!targetPanel && !!targetPanel.querySelector?.("input, select, button, [role=tab], [role=radio], provider-select, switch-toggle");
      const legacyForm = doc.getElementById("settings-form");
      if ((panelActive && hasPanelControls) || legacyForm) {
        return { ready: true, signal: "options-hydrated" };
      }
      return { ready: false, reason: "options section hydration pending", targetSection, panelActive, hasPanelControls };
    }

    if (doc.readyState === "complete") {
      return { ready: true, signal: "document-complete" };
    }
    return { ready: false, readyState: doc.readyState };
  } catch (e) {
    return { ready: false, error: String(e) };
  }
})()`;

/**
 * The clock and timer functions the poll loop runs on, injectable so a unit test can
 * drive the loop deterministically instead of asserting poll counts against real
 * elapsed milliseconds (chrome-agent-platform-2y6fr: on a loaded box one scheduling
 * overshoot could consume the whole timeoutMs budget and a test that asserts
 * "must poll multiple times" observed a single poll — a red that named the fixture
 * rather than the product). Defaults to the real clock; callers that pass nothing
 * keep the previous behaviour exactly.
 */
export interface AppReadinessTimers {
  now(): number;
  setTimeout(fn: (...args: any[]) => void, ms: number): any;
  clearTimeout(handle: any): void;
}

const REAL_READINESS_TIMERS: AppReadinessTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * The TOTAL ceiling used when a caller names none — 10000 ms, unchanged from the pre-dnqyt behaviour.
 *
 * It stays the ceiling. A harness that needs to tolerate a loaded machine does NOT get that by opting into a
 * bigger constant here: it computes its own budget at the wait with `serialFileTimeoutMs({ base, loadPerCpu })`
 * (see tests/w51r-create-click.test.ts, whose `readyBudget()` is 10000 ms scaled by the load per CPU, up to
 * MAX_LOAD_SCALE = 4 => 40000 ms), and passes that as `timeoutMs`. So the number a red reports is always the
 * number the wait actually used, and no caller's worst-case latency changes silently.
 */
export const DEFAULT_READINESS_TIMEOUT_MS = 10000;

export interface AppReadinessOptions {
  /**
   * TOTAL ceiling on the wait, in milliseconds (default 10000). This keeps its original
   * meaning: it is the longest the whole wait may take, and it is what a red reports.
   */
  timeoutMs?: number;
  /**
   * NO-PROGRESS window (dnqyt), separate from the ceiling so `timeoutMs` is not silently
   * repurposed: every observed ADVANCE in the probe result restarts this window, and the wait
   * fails as soon as the state stops advancing for this long. Default: timeoutMs. It never
   * extends the ceiling — progress can buy time inside the budget, not past it.
   */
  stallMs?: number;
  /**
   * Explicit opt-in to a LONGER total ceiling than `timeoutMs`. The option exists so a call site CAN raise the
   * ceiling deliberately. No NON-TEST call site uses it today: w51r used to, and now computes a load-aware
   * `timeoutMs` instead (see DEFAULT_READINESS_TIMEOUT_MS above). Raising the ceiling for a real worst case is a
   * decision for the operator with measurements behind it, not a harness constant. Default: timeoutMs, i.e. no
   * extension at all.
   *
   * The deliberate test uses are tests/harness-readiness.test.ts:814 and :893, which pass `maxTotalMs: 60000` on a
   * DRIVEN FAKE CLOCK (tests/harness-readiness.test.ts:39-96, `fakeTimers()` + `onFakeClock`) to prove the ceiling
   * is honoured past the 10s default. They are not a 60-second wall-clock wait and not a product opt-in.
   */
  maxTotalMs?: number;
  pollIntervalMs?: number;
  surfaceName?: string;
  predicateExpr?: string;
  probeTimeoutMs?: number;
  /** Clock/timer source for the poll loop; defaults to the real one (2y6fr). */
  timers?: AppReadinessTimers;
  /**
   * Called once per probe with what was observed and whether it ADVANCED. Harnesses use it to
   * record a probe trace beside their screenshots, so a red can be classified as stall vs
   * slow-but-hydrating from the run's own evidence (dnqyt).
   */
  onProbe?: (event: AppReadinessProbeEvent) => void;
}

export interface AppReadinessProbeEvent {
  atMs: number;
  probe: any;
  advanced: boolean;
}

export interface AppReadinessResult {
  ready: true;
  signal: string;
  elapsedMs: number;
}

/**
 * Classifies an evaluator rejection as a transport or classified evaluate timeout
 * that must propagate directly rather than being swallowed into an app-hydration failure (u7p0b).
 */
export function isTransportOrEvaluateTimeoutError(e: any): boolean {
  if (!e) return false;
  if (e instanceof CdpEvaluateLoadTimeoutError || e?.name === "CdpEvaluateLoadTimeoutError") return true;
  if (e instanceof CdpEvaluateIdleTimeoutError || e?.name === "CdpEvaluateIdleTimeoutError") return true;
  const msg = String(e?.message ?? e);
  if (isCdpEvaluateTimeout(msg)) return true;
  if (/^cdp timeout: Runtime\.evaluate/i.test(msg)) return true;
  if (/Target closed|Session (?:closed|with given id not found)|WebSocket (?:closed|is not open)|Connection closed/i.test(msg)) return true;
  if (/probe evaluation timed out/i.test(msg)) return true;
  return false;
}

/**
 * Polls for the named app-ready signal before interaction.
 *
 * Throws an Error starting with `app never became ready` if the page does not
 * signal readiness within the timeout bound.
 */
export async function waitForAppReady(
  evaluate: (expression: string) => Promise<any>,
  options: AppReadinessOptions = {},
): Promise<AppReadinessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const stallMs = options.stallMs ?? timeoutMs;
  // The ceiling can only be RAISED explicitly by a call site that says why (maxTotalMs); with no
  // opt-in the wait is bounded exactly as it always was.
  const maxTotalMs = Math.max(options.maxTotalMs ?? timeoutMs, timeoutMs);
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const surface = options.surfaceName ? ` for ${options.surfaceName}` : "";
  const expr = options.predicateExpr ?? APP_READY_EXPRESSION;
  const timers = options.timers ?? REAL_READINESS_TIMERS;
  const start = timers.now();
  const hardDeadline = start + maxTotalMs;
  // dnqyt: NTP hydration observed on this VM takes ~7.2s cold and ~12.3s with six competing
  // busy loops, and the readiness expression reports only two coarse transitions on the way
  // (jobsBoard true, then namedHydrated true). A fixed 10s stopwatch therefore reds a page
  // that is hydrating perfectly well. The bound now applies to NO PROGRESS: every observed
  // change in the probe result buys another full stallMs window, and maxTotalMs stops a page
  // that flaps forever. A genuinely never-hydrating document reports the same result forever,
  // so it still fails closed after one stallMs window — the falsifier this keeps.
  let stallDeadline = start + stallMs;
  let lastKey: string | null = null;
  let lastProbe: any = null;
  let lastTimeoutError: Error | null = null;
  let advances = 0;
  let lastAdvanceAtMs: number | null = null;

  const keyOf = (probe: any): string => {
    try {
      return JSON.stringify(probe) ?? String(probe);
    } catch {
      return String(probe);
    }
  };

  // The two terminating paths coord asked to be distinguishable, kept explicit:
  //   "stall"  -> the observed state stopped advancing (a page that will never hydrate), and
  //   "cap"    -> the state is STILL advancing but readiness never arrived inside the hard cap.
  // They produce different named reasons below, so a red says which kind of not-ready it is.
  let exitReason: "stall" | "ceiling" = "stall";
  while (true) {
    // Stall first: when the ceiling and the no-progress window expire together the honest
    // report is that the observed state stopped advancing.
    if (timers.now() >= stallDeadline) { exitReason = "stall"; break; }
    if (timers.now() >= hardDeadline) { exitReason = "ceiling"; break; }
    const remainingMs = Math.min(hardDeadline, stallDeadline) - timers.now();
    if (remainingMs <= 0) { exitReason = "stall"; break; }
    const probeLimit = Math.min(remainingMs, options.probeTimeoutMs ?? 2000);

    let probeTimer: any;
    let localProbeTimeoutError: Error | null = null;
    let observed: any;
    try {
      const probe = await Promise.race([
        evaluate(expr),
        new Promise((_, reject) => {
          probeTimer = timers.setTimeout(() => {
            localProbeTimeoutError = new Error(`probe evaluation timed out after ${probeLimit}ms${surface}`);
            reject(localProbeTimeoutError);
          }, probeLimit);
        }),
      ]);
      timers.clearTimeout(probeTimer);
      lastProbe = probe;
      lastTimeoutError = null;
      observed = probe;
      if (timers.now() <= hardDeadline && probe && typeof probe === "object" && probe.ready === true) {
        const advanced = keyOf(probe) !== lastKey;
        options.onProbe?.({ atMs: timers.now() - start, probe, advanced });
        return {
          ready: true,
          signal: typeof probe.signal === "string" ? probe.signal : "custom-predicate",
          elapsedMs: timers.now() - start,
        };
      }
    } catch (e: any) {
      timers.clearTimeout(probeTimer);
      if (localProbeTimeoutError && e === localProbeTimeoutError) {
        lastTimeoutError = e;
        lastProbe = { error: String(e) };
        // A local probe timeout is NOT progress: its message carries the remaining budget, so
        // keying off it would make every iteration look like an advance and turn a hung page
        // into an unbounded wait. Class it, don't quote it.
        observed = { probeTimedOut: true };
      } else if (isTransportOrEvaluateTimeoutError(e)) {
        throw e;
      } else {
        lastTimeoutError = null;
        lastProbe = { error: String(e) };
        observed = { evaluateError: true };
      }
    }

    const advanced = lastKey !== null && keyOf(observed) !== lastKey;
    if (advanced) {
      advances++;
      lastAdvanceAtMs = timers.now() - start;
      stallDeadline = timers.now() + stallMs;
    }
    lastKey = keyOf(observed);
    options.onProbe?.({ atMs: timers.now() - start, probe: observed, advanced });
    await new Promise((r) => timers.setTimeout(r, pollIntervalMs));
  }

  const detail = lastProbe ? ` (last probe: ${JSON.stringify(lastProbe)})` : "";
  const progress = `${advances} observed advance(s)${lastAdvanceAtMs === null ? "" : `, last at ${lastAdvanceAtMs}ms`}`;
  // A probe that never answered keeps its distinct provenance (the w7mv6/p2aki contract: that is
  // an evaluation-layer failure and must not be laundered into "app never became ready"). This is
  // the pre-dnqyt behaviour, unchanged.
  if (lastTimeoutError) {
    throw lastTimeoutError;
  }
  if (exitReason === "ceiling") {
    throw new Error(
      `${APP_NEVER_BECAME_READY}${surface}: still advancing but not ready within the ${maxTotalMs}ms ceiling (${progress})${detail}`,
    );
  }
  throw new Error(
    `${APP_NEVER_BECAME_READY}${surface}: no observed progress for ${stallMs}ms (${progress})${detail}`,
  );
}

/**
 * Wraps an interaction to guarantee that the app is ready before the interaction executes.
 * If readiness times out, throws `app never became ready` and does NOT execute the action.
 */
export async function interactWhenReady<T>(
  evaluate: (expression: string) => Promise<any>,
  action: () => Promise<T>,
  options: AppReadinessOptions = {},
): Promise<T> {
  await waitForAppReady(evaluate, options);
  return action();
}
